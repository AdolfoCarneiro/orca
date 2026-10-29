import { z } from 'zod'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { projectWorkerListFleet } from './worker/worker-list-projection'

// Only an empty check sees the whole mailbox, so only it says to stop.
const AWAIT_WAKE = "Orca wakes you when workers report; end your turn when you're done."
const FINISH_MAILBOX = 'Finish the rest of your mail.'
const MORE_MAIL = 'More mail is waiting: run check again.'
const AWAIT_WORKER_REPORTS =
  'Orca wakes you when a worker reports. Once every worker you need is started, end your turn. Do not poll.'
export const WORKER_DONE_RECORDED_NEXT = 'Recorded. End your turn.'

const ReadyWorkerStart = z.looseObject({
  state: z.literal('ready'),
  workerOutcome: z.never().optional()
})

const TakenRunCheck = z.looseObject({
  runId: z.string(),
  deliveryAcknowledged: z.literal(true)
})

const EmptyRunCheck = z.looseObject({
  runId: z.string(),
  count: z.literal(0),
  cancelled: z.literal(false).optional(),
  waitInterrupted: z.never().optional()
})

export function withWorkerStartNext(receipt: unknown): unknown {
  const ready = ReadyWorkerStart.safeParse(receipt)
  return ready.success ? { ...ready.data, next: AWAIT_WAKE } : receipt
}

export async function withRunCheckNext(
  runtime: OrcaRuntimeService,
  result: unknown
): Promise<unknown> {
  // A batch is capped, so a take that leaves unread mail behind is the one case that needs another check.
  const taken = TakenRunCheck.safeParse(result)
  if (taken.success) {
    const leftBehind = runtime.getOrchestrationDb().getUnreadRunMailbox(taken.data.runId, 1)
    return leftBehind.length > 0 ? { ...taken.data, next: MORE_MAIL } : result
  }
  const empty = EmptyRunCheck.safeParse(result)
  return empty.success && (await awaitsWorkerReports(runtime, empty.data.runId))
    ? { ...empty.data, next: AWAIT_WORKER_REPORTS }
    : result
}

/** A question arrives in a batch the caller has not finished handling. */
export function withAnswerNext<T extends object>(receipt: T): T & { next: string } {
  return { ...receipt, next: FINISH_MAILBOX }
}

/** A worker still runs and worker-list owes no action: each running worker's stop or exit sends mail. */
async function awaitsWorkerReports(runtime: OrcaRuntimeService, runId: string): Promise<boolean> {
  const db = runtime.getOrchestrationDb()
  const rows = db.listWorkerTerminalResources({ runId })
  const { workers } = await projectWorkerListFleet(runtime, rows, {
    limit: rows.length,
    completeProjection: true
  })
  return (
    workers.some((worker) => worker.outcome === 'in_progress') &&
    workers.every((worker) => worker.nextAction.kind === 'none')
  )
}
