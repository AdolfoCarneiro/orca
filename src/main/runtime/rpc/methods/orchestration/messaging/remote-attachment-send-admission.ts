import type { OrchestrationCompatibilityEvidence } from '../../../../../../shared/orchestration-compatibility-evidence'
import type {
  OrcaRuntimeService,
  OrchestrationCompatibilityCallerAuthority
} from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import { isEquivalentPaneKey } from '../../../../orchestration/db/pane-key-match'
import { isGroupAddress } from '../../../../orchestration/groups'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { WorkerDispatchState } from '../../../../orchestration/types'
import { assertWorkerCanReport } from '../../../../orchestration/worker-report-admission'
import { isDispatchMutationMessageType, parseRemoteWorkerPayload } from '../schemas'

export function usesAttachedLocalRecipient(
  params: { to?: string; type?: string },
  attachment: { dispatch_id: string; home_run_id: string }
): boolean {
  return Boolean(
    params.to &&
    !isDispatchMutationMessageType(params.type) &&
    !isGroupAddress(params.to) &&
    !params.to.startsWith('task:') &&
    params.to !== `run:${attachment.home_run_id}` &&
    params.to !== `dispatch:${attachment.dispatch_id}`
  )
}

export function assertRemoteAttachmentSendAdmission(args: {
  dispatchId: string
  from: string
  workerState: WorkerDispatchState | undefined
  processCurrent: boolean
  payload: string | undefined
}): Record<string, unknown> {
  assertWorkerCanReport(args)
  const payload = parseRemoteWorkerPayload(args.payload)
  if (typeof payload.dispatchId === 'string' && payload.dispatchId !== args.dispatchId) {
    throw new OrchestrationError(
      'dispatch_inactive',
      `Dispatch ${payload.dispatchId} is not the active remote Dispatch for this pane.`
    )
  }
  return payload
}

export function admitAttachedLocalSend(args: {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  from: string
  senderPaneKey: string
  attachment: { dispatch_id: string; state: WorkerDispatchState }
  processIncarnation: string | undefined
  payload: string | undefined
  callerAuthority: OrchestrationCompatibilityCallerAuthority | undefined
  evidence: OrchestrationCompatibilityEvidence | undefined
}): { routingPayload: string | undefined; revalidate: () => void } {
  const { runtime, db, from, senderPaneKey, attachment, processIncarnation } = args
  const payload = assertRemoteAttachmentSendAdmission({
    dispatchId: attachment.dispatch_id,
    from,
    workerState: attachment.state,
    processCurrent: db.isRemoteAttachmentProcessCurrent({
      dispatchId: attachment.dispatch_id,
      paneKey: senderPaneKey,
      processIncarnation: processIncarnation ?? null
    }),
    payload: args.payload
  })
  let routingPayload = args.payload
  if (typeof payload.dispatchId === 'string') {
    const targetPayload = { ...payload }
    delete targetPayload.dispatchId
    routingPayload = JSON.stringify(targetPayload)
  }
  return {
    routingPayload,
    revalidate: () => {
      const current = db.findActiveRemoteAttachmentForPane(senderPaneKey)
      const authority = args.callerAuthority
        ? runtime.verifyOrchestrationCompatibilityCaller(args.evidence)
        : undefined
      const currentPane = args.callerAuthority
        ? authority?.paneKey
        : runtime.getTerminalPaneKey(from)
      const currentProcess = args.callerAuthority
        ? authority?.processIncarnation
        : runtime.getTerminalProcessIncarnation(from)
      assertWorkerCanReport({
        dispatchId: attachment.dispatch_id,
        from,
        workerState: current?.state,
        processCurrent: Boolean(
          current?.dispatch_id === attachment.dispatch_id &&
          currentPane &&
          isEquivalentPaneKey(currentPane, senderPaneKey) &&
          currentProcess === processIncarnation &&
          (!args.callerAuthority ||
            (authority?.terminalHandle === from &&
              authority.launchTokenHash === args.callerAuthority.launchTokenHash)) &&
          db.isRemoteAttachmentProcessCurrent({
            dispatchId: attachment.dispatch_id,
            paneKey: senderPaneKey,
            processIncarnation: processIncarnation ?? null
          })
        )
      })
    }
  }
}
