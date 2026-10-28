import { z } from 'zod'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { projectWorkerListFleet } from './worker/worker-list-projection'
import { chatAssigneeSessionId } from '../../../orchestration/chat-assignee'
import { isStructuredWorkerHandle } from '../../../../../shared/structured-worker-handle'

// A receipt carries `next` only where stopping is the right move; without it, act on the receipt.
const AWAIT_WORKER_REPORTS =
  'Orca wakes you when a worker reports. Once every worker you need is started, end your turn. Do not poll.'
export const WORKER_DONE_RECORDED_NEXT = 'Recorded. End your turn.'

const ReadyWorkerStart = z.looseObject({
  state: z.literal('ready'),
  workerOutcome: z.never().optional()
})

const EmptyRunCheck = z.looseObject({
  runId: z.string(),
  count: z.literal(0),
  cancelled: z.literal(false).optional(),
  waitInterrupted: z.never().optional()
})

/** A worker that already reported left mail to act on, so only an unreported start says to stop. */
export async function withWorkerStartNext(
  runtime: OrcaRuntimeService,
  runId: string,
  receipt: unknown
): Promise<unknown> {
  const ready = ReadyWorkerStart.safeParse(receipt)
  return ready.success && (await awaitsWorkerReports(runtime, runId))
    ? { ...ready.data, next: AWAIT_WORKER_REPORTS }
    : receipt
}

export async function withRunCheckNext(
  runtime: OrcaRuntimeService,
  result: unknown
): Promise<unknown> {
  const empty = EmptyRunCheck.safeParse(result)
  return empty.success && (await awaitsWorkerReports(runtime, empty.data.runId))
    ? { ...empty.data, next: AWAIT_WORKER_REPORTS }
    : result
}

/** A worker still runs, worker-list owes no action, and every running worker's failure wakes the coordinator. */
async function awaitsWorkerReports(runtime: OrcaRuntimeService, runId: string): Promise<boolean> {
  const rows = runtime.getOrchestrationDb().listWorkerTerminalResources({ runId })
  const { workers } = await projectWorkerListFleet(runtime, rows, {
    limit: rows.length,
    completeProjection: true
  })
  const running = new Set(
    workers.filter((worker) => worker.outcome === 'in_progress').map((worker) => worker.dispatchId)
  )
  return (
    running.size > 0 &&
    workers.every((worker) => worker.nextAction.kind === 'none') &&
    failuresSendMail(
      runtime,
      rows.filter((row) => running.has(row.dispatchId))
    )
  )
}

/** A remote exit sends no mail, and a chat failure sends it only while the user allows that. */
function failuresSendMail(
  runtime: OrcaRuntimeService,
  rows: { dispatchId: string; agentTerminalHandle: string | null }[]
): boolean {
  const ids = rows.map((row) => row.dispatchId)
  if (runtime.getOrchestrationDb().listFederatedDispatchesByIds(ids).length > 0) {
    return false
  }
  return (
    runtime.isChatWorkerErrorEscalationEnabled() ||
    !rows.some(
      (row) =>
        chatAssigneeSessionId(row.agentTerminalHandle) ||
        isStructuredWorkerHandle(row.agentTerminalHandle)
    )
  )
}
