import type { OrcaRuntimeService } from '../orca-runtime'
import { resolveStructuredWorkerIdentityForSession } from '../structured-worker-authority'

/** A person's admitted chat send takes a worker over on the host, so no client report can be lost or lag it. */
export function recordStructuredWorkerUserSend<Result extends { ok: boolean }>(
  runtime: OrcaRuntimeService,
  sessionId: string,
  result: Result
): Result {
  if (!result.ok) {
    return result
  }
  try {
    const db = runtime.getExistingOrchestrationDb()
    const paneKey = resolveStructuredWorkerIdentityForSession(sessionId, db)?.paneKey
    if (db && paneKey) {
      // The keep first cancels an automatic close already past its archive commit, so the takeover applies.
      db.markWorkerTouched(paneKey)
      db.markWorkerTerminalUserOwned(paneKey)
    }
  } catch (error) {
    // The send is already admitted; a failed record leaves the worker to its normal release.
    console.warn('[orchestration] structured worker takeover record failed', error)
  }
  return result
}
