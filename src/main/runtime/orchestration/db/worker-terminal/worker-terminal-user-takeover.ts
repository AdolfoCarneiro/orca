import { isEquivalentPaneKey } from '../pane-key-match'
import type { OrchestrationDb } from '../orchestration-db'
import { retainTerminalResourceInTransaction } from './worker-terminal-archive'

const USER_CLAIMABLE_RESOURCE_SQL = `ownership_state = 'owned'
  AND release_state IN ('not_requested', 'retained', 'requested')
  AND NOT EXISTS (
    SELECT 1 FROM worker_dispatches w
     WHERE w.dispatch_id = owner_dispatch_id AND w.state = 'stopping'
  )`

type UserClaimableResource = { id: string; owner_dispatch_id: string; pane_key: string }

// Exact pane key first; a reminted tab id still names the same leaf.
function findUserClaimableResources(db: OrchestrationDb, paneKey: string): UserClaimableResource[] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this projection selects exactly the three columns the row type names.
  const exact = db.db
    .prepare(
      `SELECT id, owner_dispatch_id, pane_key FROM worker_terminal_resources
        WHERE pane_key = ? AND ${USER_CLAIMABLE_RESOURCE_SQL}`
    )
    .all(paneKey) as UserClaimableResource[]
  if (exact.length > 0) {
    return exact
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this projection selects exactly the three columns the row type names.
  const candidates = db.db
    .prepare(
      `SELECT id, owner_dispatch_id, pane_key FROM worker_terminal_resources
        WHERE ${USER_CLAIMABLE_RESOURCE_SQL} AND pane_key IS NOT NULL`
    )
    .all() as UserClaimableResource[]
  return candidates.filter((candidate) => isEquivalentPaneKey(candidate.pane_key, paneKey))
}

export function markWorkerTerminalUserOwned(this: OrchestrationDb, paneKey: string): number {
  return takeOverForUser(
    this,
    () => findUserClaimableResources(this, paneKey),
    USER_CLAIMABLE_RESOURCE_SQL
  )
}

// A touch yields only an automatic release, until its close is admitted in the session lane.
const TOUCH_CLAIMABLE_RESOURCE_SQL = `ownership_state = 'owned' AND auto_release_at IS NOT NULL
  AND auto_release_dispatch_id = owner_dispatch_id
  AND release_state IN ('not_requested', 'requested', 'releasing')`

/** The user opened or watched a finished worker's chat; running workers and explicit releases ignore it. */
export function markWorkerChatTouched(this: OrchestrationDb, paneKey: string): number {
  return takeOverForUser(
    this,
    () =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this projection selects exactly the three columns the row type names.
      this.db
        .prepare(
          `SELECT id, owner_dispatch_id, pane_key FROM worker_terminal_resources
            WHERE pane_key = ? AND ${TOUCH_CLAIMABLE_RESOURCE_SQL}`
        )
        .all(paneKey) as UserClaimableResource[],
    TOUCH_CLAIMABLE_RESOURCE_SQL
  )
}

function takeOverForUser(
  database: OrchestrationDb,
  findCandidates: () => UserClaimableResource[],
  claimableSql: string
): number {
  database.db.exec('BEGIN IMMEDIATE')
  try {
    const update = database.db.prepare(
      `UPDATE worker_terminal_resources
       SET ownership_state = 'user_owned', release_state = 'retained',
           retained_reason = 'user_takeover', auto_release_at = NULL, updated_at = datetime('now')
       WHERE id = ? AND ${claimableSql}`
    )
    let changed = 0
    for (const candidate of findCandidates()) {
      const result = Number(update.run(candidate.id).changes)
      if (result > 0) {
        database.db
          .prepare('DELETE FROM worker_terminal_archives WHERE dispatch_id = ?')
          .run(candidate.owner_dispatch_id)
        changed += result
      }
    }
    database.db.exec('COMMIT')
    return changed
  } catch (error) {
    database.db.exec('ROLLBACK')
    throw error
  }
}

/** The user's "Keep worker": the same durable retain worker-retain records, addressed by pane. */
export function retainWorkerTerminalForUser(this: OrchestrationDb, paneKey: string): number {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    let changed = 0
    for (const candidate of findUserClaimableResources(this, paneKey)) {
      if (retainTerminalResourceInTransaction(this, candidate.id, candidate.owner_dispatch_id)) {
        changed += 1
      }
    }
    this.db.exec('COMMIT')
    return changed
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}
