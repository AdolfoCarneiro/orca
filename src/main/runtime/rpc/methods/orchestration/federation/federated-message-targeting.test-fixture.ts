import { vi } from 'vitest'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db'
import type { RpcRequest } from '../../../core'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../../../shared/protocol-version'

/** A worker pane bound to remote Dispatch ctx_remote_targeting, whose Run home is `run-home`. */
export function attachedRemoteWorker(): { db: OrchestrationDb; runtime: OrcaRuntimeService } {
  const db = new OrchestrationDb(':memory:')
  const runtime = new OrcaRuntimeService()
  runtime.setOrchestrationDb(db)
  vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue('tab_worker:leaf_worker')
  attachRemoteDispatch(db, runtime, 'run-home')
  return { db, runtime }
}

export function attachRemoteDispatch(
  db: OrchestrationDb,
  runtime: OrcaRuntimeService,
  runId: string,
  surface: { paneKey?: string; terminalHandle?: string; dispatchId?: string } = {}
) {
  const processIncarnation = 'worker_epoch:pty:1'
  const dispatchId = surface.dispatchId ?? 'ctx_remote_targeting'
  const paneKey = surface.paneKey ?? 'tab_worker:leaf_worker'
  vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue(processIncarnation)
  db.createRemoteDispatchAttachment({
    runId,
    dispatchId,
    taskId: 'task_remote_targeting',
    homePeerFingerprint: 'home_peer',
    protocolVersion: 1,
    runtimeEpoch: runtime.getRuntimeId(),
    mutationReceipt: {
      callerFingerprint: 'home_peer',
      requestId: `attach_request_${dispatchId}`,
      method: 'orchestration.federationAttachStart',
      payloadHash: 'attach_payload'
    }
  })
  db.prepareRemoteAttachmentAuthority({
    dispatchId,
    paneKey,
    processIncarnation,
    worktreeId: 'repo::remote-worktree',
    terminalHandle: surface.terminalHandle ?? 'term_remote_worker',
    setupState: 'not_applicable',
    effects: []
  })
  db.markRemoteAttachmentReady(dispatchId)
}

export function request(
  id: string,
  method: 'orchestration.send' | 'orchestration.ask' | 'orchestration.reply',
  params: Record<string, unknown>
): RpcRequest {
  return {
    id: `rpc_${id}`,
    authToken: 'worker-token',
    orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
    orchestrationRequestId: `request_${id}`,
    method,
    params
  }
}
