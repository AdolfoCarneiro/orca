import { STRUCTURED_WORKER_HANDLE_PREFIX } from '../../../../../shared/structured-worker-handle'
import {
  liveWorkerTerminalAutoReleaseAt,
  WORKER_RELEASABLE_STATES,
  WORKER_TERMINAL_AUTO_RELEASE_LIVE_SQL
} from '../../worker-terminal-ownership'
import type { OrchestrationDb } from '../orchestration-db'
import { exposeUtcTimestamp, toSqliteUtcTimestamp } from '../utc-timestamp'

export const WORKER_TERMINAL_AUTO_RELEASE_GRACE_MS = 2 * 60_000

const RELEASABLE_STATES_SQL = WORKER_RELEASABLE_STATES.map((state) => `'${state}'`).join(', ')

/** Arm once per owning Dispatch inside its settlement transaction; a repeat report never extends it.
 *  Chat workers arm only while every connected client reports touches; otherwise they stay on manual release. */
export function armWorkerTerminalAutoReleaseStatement(
  this: OrchestrationDb,
  dispatchId: string,
  nowMs = Date.now()
): void {
  const { changes } = this.db
    .prepare(
      `UPDATE worker_terminal_resources
          SET auto_release_at = ?, auto_release_dispatch_id = owner_dispatch_id,
              updated_at = datetime('now')
        WHERE owner_dispatch_id = ? AND ownership_state = 'owned'
          AND release_state = 'not_requested'
          AND auto_release_dispatch_id IS NOT owner_dispatch_id
          AND (? OR substr(terminal_handle, 1, ?) != ?)`
    )
    .run(
      toSqliteUtcTimestamp(nowMs + WORKER_TERMINAL_AUTO_RELEASE_GRACE_MS),
      dispatchId,
      this.chatWorkerAutoReleaseArmable?.() ? 1 : 0,
      STRUCTURED_WORKER_HANDLE_PREFIX.length,
      STRUCTURED_WORKER_HANDLE_PREFIX
    )
  if (changes > 0) {
    this.workerTerminalAutoReleaseListener?.()
  }
}

/** The automatic counterpart of a release request: it never overrides retention, takeover or transfer.
 *  The kept deadline marks the request automatic until an explicit request clears it. */
export function claimDueWorkerTerminalAutoReleases(this: OrchestrationDb, nowMs: number): number {
  return Number(
    this.db
      .prepare(
        `UPDATE worker_terminal_resources
            SET release_state = 'requested', retained_reason = NULL,
                release_requested_at = datetime('now'), release_error = NULL,
                updated_at = datetime('now')
          WHERE ${WORKER_TERMINAL_AUTO_RELEASE_LIVE_SQL} AND auto_release_at <= ?
            AND (
              EXISTS (
                SELECT 1 FROM worker_dispatches w
                 WHERE w.dispatch_id = worker_terminal_resources.owner_dispatch_id
                   AND w.state IN (${RELEASABLE_STATES_SQL})
              )
              OR EXISTS (
                SELECT 1 FROM remote_dispatch_attachments a
                 WHERE a.dispatch_id = worker_terminal_resources.owner_dispatch_id
                   AND a.state IN (${RELEASABLE_STATES_SQL})
              )
            )`
      )
      .run(toSqliteUtcTimestamp(nowMs)).changes
  )
}

export function nextWorkerTerminalAutoReleaseAtMs(this: OrchestrationDb): number | null {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: an aggregate SELECT always returns exactly this one-column row.
  const row = this.db
    .prepare(
      `SELECT MIN(auto_release_at) AS at FROM worker_terminal_resources
        WHERE ${WORKER_TERMINAL_AUTO_RELEASE_LIVE_SQL}`
    )
    .get() as { at: string | null }
  return row.at ? Date.parse(exposeUtcTimestamp(row.at) ?? row.at) : null
}

export function getLiveWorkerTerminalAutoReleaseAt(
  this: OrchestrationDb,
  dispatchId: string
): string | null {
  return liveWorkerTerminalAutoReleaseAt(this.getWorkerTerminalResourceByOwner(dispatchId))
}

export type WorkerTerminalAutoReleaseMethods = {
  getLiveWorkerTerminalAutoReleaseAt: typeof getLiveWorkerTerminalAutoReleaseAt
  armWorkerTerminalAutoReleaseStatement: typeof armWorkerTerminalAutoReleaseStatement
  claimDueWorkerTerminalAutoReleases: typeof claimDueWorkerTerminalAutoReleases
  nextWorkerTerminalAutoReleaseAtMs: typeof nextWorkerTerminalAutoReleaseAtMs
}

export function attachWorkerTerminalAutoRelease(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    getLiveWorkerTerminalAutoReleaseAt,
    armWorkerTerminalAutoReleaseStatement,
    claimDueWorkerTerminalAutoReleases,
    nextWorkerTerminalAutoReleaseAtMs
  })
}
