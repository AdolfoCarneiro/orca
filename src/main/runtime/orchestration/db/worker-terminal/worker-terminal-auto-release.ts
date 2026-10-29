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

/** The automatic chat close's last word, run in the session lane right before Stop. Clearing the deadline
 *  ends touches; a client that cannot report touches cancels it back to manual release. Explicit releases pass. */
export function admitWorkerChatReleaseClose(this: OrchestrationDb, resourceId: string): boolean {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const resource = this.getWorkerTerminalResource(resourceId)
    let admitted = resource?.ownership_state === 'owned' && resource.release_state === 'releasing'
    if (admitted && resource!.auto_release_at !== null) {
      admitted = this.chatWorkerAutoReleaseArmable?.() === true
      this.db
        .prepare(
          admitted
            ? `UPDATE worker_terminal_resources SET auto_release_at = NULL, updated_at = datetime('now')
                WHERE id = ?`
            : `UPDATE worker_terminal_resources
                  SET release_state = 'not_requested', auto_release_at = NULL, archive_source = NULL,
                      archive_status = NULL, release_requested_at = NULL, updated_at = datetime('now')
                WHERE id = ?`
        )
        .run(resourceId)
      if (!admitted) {
        this.db
          .prepare('DELETE FROM worker_terminal_archives WHERE dispatch_id = ?')
          .run(resource!.owner_dispatch_id)
      }
    }
    this.db.exec('COMMIT')
    return admitted
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

/** Only for a host that cannot release on its own; arms once, so a retain or release before settlement still wins. */
export function armFederatedHomeAutoRelease(
  this: OrchestrationDb,
  dispatchId: string,
  nowMs = Date.now()
): void {
  const { changes } = this.db
    .prepare(
      `UPDATE federated_dispatches
          SET home_auto_release_at = ?, home_auto_release_state = 'armed', updated_at = datetime('now')
        WHERE dispatch_id = ? AND home_auto_release_state IS NULL`
    )
    .run(toSqliteUtcTimestamp(nowMs + WORKER_TERMINAL_AUTO_RELEASE_GRACE_MS), dispatchId)
  if (changes > 0) {
    this.workerTerminalAutoReleaseListener?.()
  }
}

/** A retain, an explicit release or the host's answer to an attempt ends the home deadline for good. */
export function endFederatedHomeAutoRelease(this: OrchestrationDb, dispatchId: string): void {
  this.db
    .prepare(
      `UPDATE federated_dispatches
          SET home_auto_release_at = NULL, home_auto_release_state = 'ended', updated_at = datetime('now')
        WHERE dispatch_id = ? AND home_auto_release_state IS NOT 'ended'`
    )
    .run(dispatchId)
}

/** Claiming postpones the deadline instead of hiding it, so an attempt cut short by a crash or failure runs again. */
export function claimDueFederatedHomeAutoReleases(this: OrchestrationDb, nowMs: number): string[] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the SELECT names exactly this one column.
  const due = this.db
    .prepare(
      `SELECT dispatch_id FROM federated_dispatches
        WHERE home_auto_release_state = 'armed' AND home_auto_release_at <= ?`
    )
    .all(toSqliteUtcTimestamp(nowMs)) as { dispatch_id: string }[]
  const claim = this.db.prepare(
    `UPDATE federated_dispatches
        SET home_auto_release_at = ?, updated_at = datetime('now')
      WHERE dispatch_id = ? AND home_auto_release_state = 'armed' AND home_auto_release_at <= ?`
  )
  const retryAt = toSqliteUtcTimestamp(nowMs + WORKER_TERMINAL_AUTO_RELEASE_GRACE_MS)
  return due.flatMap(({ dispatch_id }) =>
    claim.run(retryAt, dispatch_id, toSqliteUtcTimestamp(nowMs)).changes > 0 ? [dispatch_id] : []
  )
}

export function isFederatedHomeAutoReleaseArmed(
  this: OrchestrationDb,
  dispatchId: string
): boolean {
  return (
    this.db
      .prepare(
        `SELECT 1 FROM federated_dispatches
          WHERE dispatch_id = ? AND home_auto_release_state = 'armed'`
      )
      .get(dispatchId) !== undefined
  )
}

export function nextWorkerTerminalAutoReleaseAtMs(this: OrchestrationDb): number | null {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: an aggregate SELECT always returns exactly this one-column row.
  const row = this.db
    .prepare(
      `SELECT MIN(at) AS at FROM (
         SELECT MIN(auto_release_at) AS at FROM worker_terminal_resources
          WHERE ${WORKER_TERMINAL_AUTO_RELEASE_LIVE_SQL}
         UNION ALL
         SELECT MIN(home_auto_release_at) FROM federated_dispatches
          WHERE home_auto_release_state = 'armed'
       )`
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
  admitWorkerChatReleaseClose: typeof admitWorkerChatReleaseClose
  nextWorkerTerminalAutoReleaseAtMs: typeof nextWorkerTerminalAutoReleaseAtMs
  armFederatedHomeAutoRelease: typeof armFederatedHomeAutoRelease
  endFederatedHomeAutoRelease: typeof endFederatedHomeAutoRelease
  claimDueFederatedHomeAutoReleases: typeof claimDueFederatedHomeAutoReleases
  isFederatedHomeAutoReleaseArmed: typeof isFederatedHomeAutoReleaseArmed
}

export function attachWorkerTerminalAutoRelease(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    getLiveWorkerTerminalAutoReleaseAt,
    armWorkerTerminalAutoReleaseStatement,
    claimDueWorkerTerminalAutoReleases,
    admitWorkerChatReleaseClose,
    nextWorkerTerminalAutoReleaseAtMs,
    armFederatedHomeAutoRelease,
    endFederatedHomeAutoRelease,
    claimDueFederatedHomeAutoReleases,
    isFederatedHomeAutoReleaseArmed
  })
}
