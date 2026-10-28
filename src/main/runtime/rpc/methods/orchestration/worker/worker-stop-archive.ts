import type { OrchestrationDb } from '../../../../orchestration/db'
import { captureWorkerOutputArchive } from '../../../../orchestration/worker-output-archive'
import type { WorkerTerminalReleaseRuntime } from '../../../../orchestration/worker-terminal-release-runtime'
import { resolveStructuredWorkerForDispatch } from '../../orchestration-structured-worker-lifecycle'
import { orchestrationTimestampToMs } from './worker-output'

/** Archive a worker's output before stop closes its terminal; release would otherwise find nothing to keep. */
export async function archiveWorkerOutputBeforeStop(args: {
  runtime: WorkerTerminalReleaseRuntime
  db: OrchestrationDb
  dispatchId: string
  terminalHandle: string
  attachedAt: string
}): Promise<void> {
  const { db, dispatchId } = args
  const resource = db.getWorkerTerminalResourceByOwner(dispatchId)
  if (
    !resource ||
    resource.ownership_state !== 'owned' ||
    db.getWorkerTerminalArchive(dispatchId)
  ) {
    return
  }
  try {
    const captured = await captureWorkerOutputArchive({
      runtime: args.runtime,
      dispatchId,
      terminalHandle: args.terminalHandle,
      attachedAtMs: orchestrationTimestampToMs(args.attachedAt),
      structuredWorker: resolveStructuredWorkerForDispatch(db, dispatchId)
    })
    db.storeWorkerTerminalArchiveBeforeStop({
      dispatchId,
      resourceId: resource.id,
      kind: captured.kind,
      content: JSON.stringify(captured.content),
      archiveSource: captured.kind === 'terminal_tail' ? 'terminal' : 'transcript',
      archiveStatus: captured.status
    })
  } catch (error) {
    // Stopping matters more than the copy; release reports the archive unavailable instead.
    console.warn('[orchestration] worker output was not archived before stop', dispatchId, error)
  }
}
