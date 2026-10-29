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
function findResources(
  db: OrchestrationDb,
  paneKey: string,
  claimableSql: string
): UserClaimableResource[] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this projection selects exactly the three columns the row type names.
  const exact = db.db
    .prepare(
      `SELECT id, owner_dispatch_id, pane_key FROM worker_terminal_resources
        WHERE pane_key = ? AND ${claimableSql}`
    )
    .all(paneKey) as UserClaimableResource[]
  if (exact.length > 0) {
    return exact
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this projection selects exactly the three columns the row type names.
  const candidates = db.db
    .prepare(
      `SELECT id, owner_dispatch_id, pane_key FROM worker_terminal_resources
        WHERE ${claimableSql} AND pane_key IS NOT NULL`
    )
    .all() as UserClaimableResource[]
  return candidates.filter((candidate) => isEquivalentPaneKey(candidate.pane_key, paneKey))
}

export function markWorkerTerminalUserOwned(this: OrchestrationDb, paneKey: string): number {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const update = this.db.prepare(
      `UPDATE worker_terminal_resources
       SET ownership_state = 'user_owned', release_state = 'retained',
           retained_reason = 'user_takeover', auto_release_at = NULL, updated_at = datetime('now')
       WHERE id = ? AND ${USER_CLAIMABLE_RESOURCE_SQL}`
    )
    let changed = 0
    for (const candidate of findResources(this, paneKey, USER_CLAIMABLE_RESOURCE_SQL)) {
      const result = Number(update.run(candidate.id).changes)
      if (result > 0) {
        this.db
          .prepare('DELETE FROM worker_terminal_archives WHERE dispatch_id = ?')
          .run(candidate.owner_dispatch_id)
        changed += result
      }
    }
    this.db.exec('COMMIT')
    return changed
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

// Seen keeps a worker as "Keep worker" does, at any stage up to its close's admission; explicit releases pass.
const TOUCH_KEEPABLE_RESOURCE_SQL = `ownership_state = 'owned' AND (release_state = 'not_requested'
  OR (release_state IN ('requested', 'releasing') AND auto_release_at IS NOT NULL
      AND auto_release_dispatch_id = owner_dispatch_id))`

/** The user saw the worker's terminal or chat: Orca never closes it automatically, the coordinator still may. */
export function markWorkerTouched(this: OrchestrationDb, paneKey: string): number {
  return keepForUser(this, paneKey, TOUCH_KEEPABLE_RESOURCE_SQL)
}

/** The user's "Keep worker": the same durable retain worker-retain records, addressed by pane. */
export function retainWorkerTerminalForUser(this: OrchestrationDb, paneKey: string): number {
  return keepForUser(this, paneKey, USER_CLAIMABLE_RESOURCE_SQL)
}

function keepForUser(database: OrchestrationDb, paneKey: string, keepableSql: string): number {
  database.db.exec('BEGIN IMMEDIATE')
  try {
    let changed = 0
    for (const candidate of findResources(database, paneKey, keepableSql)) {
      if (
        retainTerminalResourceInTransaction(
          database,
          candidate.id,
          candidate.owner_dispatch_id,
          keepableSql
        )
      ) {
        changed += 1
      }
    }
    database.db.exec('COMMIT')
    return changed
  } catch (error) {
    database.db.exec('ROLLBACK')
    throw error
  }
}
