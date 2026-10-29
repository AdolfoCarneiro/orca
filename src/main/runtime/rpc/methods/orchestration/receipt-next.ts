import { z } from 'zod'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { projectWorkerListFleet } from './worker/worker-list-projection'

// Only an empty check sees the whole mailbox, so only it says to stop; the rest drain first.
const DRAIN_MAILBOX =
  'Handle the rest of the mail you already read and start any other workers you need, then run check until count is 0 and follow its next.'
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

/** A start may come mid-batch, so it sends the caller to `check`, which alone decides stopping. */
export function withWorkerStartNext(receipt: unknown): unknown {
  const ready = ReadyWorkerStart.safeParse(receipt)
  return ready.success ? { ...ready.data, next: DRAIN_MAILBOX } : receipt
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

/** A question arrives in a batch the caller has not finished handling. */
export function withAnswerNext<T extends object>(receipt: T): T & { next: string } {
  return { ...receipt, next: DRAIN_MAILBOX }
}

/** A worker still runs, worker-list owes no action, and no running worker is remote: a remote exit sends no mail. */
async function awaitsWorkerReports(runtime: OrcaRuntimeService, runId: string): Promise<boolean> {
  const db = runtime.getOrchestrationDb()
  const rows = db.listWorkerTerminalResources({ runId })
  const { workers } = await projectWorkerListFleet(runtime, rows, {
    limit: rows.length,
    completeProjection: true
  })
  const running = workers
    .filter((worker) => worker.outcome === 'in_progress')
    .map((worker) => worker.dispatchId)
  return (
    running.length > 0 &&
    workers.every((worker) => worker.nextAction.kind === 'none') &&
    db.listFederatedDispatchesByIds(running).length === 0
  )
}
