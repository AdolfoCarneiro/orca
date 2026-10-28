import type { OrchestrationDb } from '../../../../orchestration/db'
import { captureWorkerOutputArchive } from '../../../../orchestration/worker-output-archive'
import type { WorkerTerminalReleaseRuntime } from '../../../../orchestration/worker-terminal-release-runtime'
import { resolveStructuredWorkerForDispatch } from '../../orchestration-structured-worker-lifecycle'
import { orchestrationTimestampToMs } from './worker-output'
import { withTimeout } from '../../../../../../shared/promise-timeout-fallback'

// Well inside the 30 s remote stop RPC budget.
const STOP_ARCHIVE_TIMEOUT_MS = 5_000

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
  // Stopping matters more than the copy; on failure or timeout, release reports the archive unavailable.
  const captured = await withTimeout(
    captureWorkerOutputArchive({
      runtime: args.runtime,
      dispatchId,
      terminalHandle: args.terminalHandle,
      attachedAtMs: orchestrationTimestampToMs(args.attachedAt),
      structuredWorker: resolveStructuredWorkerForDispatch(db, dispatchId)
    }),
    STOP_ARCHIVE_TIMEOUT_MS,
    null
  )
  if (!captured) {
    console.warn('[orchestration] worker output was not archived before stop', dispatchId)
    return
  }
  db.storeWorkerTerminalArchiveBeforeStop({
    dispatchId,
    resourceId: resource.id,
    kind: captured.kind,
    content: JSON.stringify(captured.content),
    archiveSource: captured.kind === 'terminal_tail' ? 'terminal' : 'transcript',
    archiveStatus: captured.status
  })
}
