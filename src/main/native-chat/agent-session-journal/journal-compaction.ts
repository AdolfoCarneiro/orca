// The checkpoint owns the folded prefix; retained first/current touches keep catch-up complete.

import type { JournalHostDatabase } from './journal-host-database'
import { readJournalRowsAfter, readJournalSessionEpoch } from './journal-row-table'
import { isJournalStopOrResumeRow, parseJournalRow, type JournalRow } from './journal-row-schema'
import { readJournalSavedState } from './journal-saved-state'

export type JournalMaintenancePace = () => Promise<JournalHostDatabase | null>

const PAGE_ROWS = 32
const DELETE_ROWS = 8

function contributions(row: JournalRow): { kind: string; itemId: string; revision: number }[] {
  if (row.kind === 'lifecycle-batch') {
    return row.mutations
  }
  return row.kind === 'item' || (row.kind === 'tombstone' && !isJournalStopOrResumeRow(row))
    ? [row]
    : []
}

/** Validate the entire retained prefix before deleting anything; gaps covered by the save are normal. */
export async function compactJournalSession(
  database: JournalHostDatabase,
  sessionId: string,
  epoch: string,
  pace: JournalMaintenancePace
): Promise<number | null> {
  if (readJournalSessionEpoch(database.db, sessionId) !== epoch) {
    return 0
  }
  const saved = readJournalSavedState(database.db, sessionId, epoch)
  if (!saved) {
    return 0
  }
  const touches = new Map<string, { first: number; last: number }>()
  const witnessed = new Set<string>()
  const resolve = (id: string): string => saved.aliases.get(id) ?? id
  let after = Number.MIN_SAFE_INTEGER
  for (;;) {
    if ((await pace()) !== database) {
      return null
    }
    const page = readJournalRowsAfter(database.db, sessionId, epoch, after, PAGE_ROWS)
    for (const entry of page) {
      if (entry.seq > saved.lastSequence) {
        break
      }
      const parsed = parseJournalRow(entry.rowJson)
      // An unreadable retained row parks this whole chat, including candidates preceding it.
      if (!parsed.ok || parsed.row.seq !== entry.seq || parsed.row.epoch !== epoch) {
        return 0
      }
      for (const contribution of contributions(parsed.row)) {
        const id = resolve(contribution.itemId)
        touches.set(id, { first: touches.get(id)?.first ?? entry.seq, last: entry.seq })
        const current = saved.items.get(id)
        if (
          (current && contribution.kind === 'item' && contribution.revision === current.revision) ||
          (!current &&
            contribution.kind === 'tombstone' &&
            contribution.revision === saved.tombstones.get(id))
        ) {
          witnessed.add(id)
        }
      }
    }
    const last = page.at(-1)
    if (!last || last.seq >= saved.lastSequence || page.length < PAGE_ROWS) {
      break
    }
    after = last.seq
  }

  let deleted = 0
  after = Number.MIN_SAFE_INTEGER
  for (;;) {
    if ((await pace()) !== database) {
      return null
    }
    const page = readJournalRowsAfter(database.db, sessionId, epoch, after, PAGE_ROWS)
    const obsolete: number[] = []
    for (const entry of page) {
      if (entry.seq > saved.lastSequence) {
        break
      }
      const parsed = parseJournalRow(entry.rowJson)
      if (!parsed.ok || parsed.row.seq !== entry.seq || parsed.row.epoch !== epoch) {
        return null
      }
      const row = parsed.row
      if (row.kind !== 'item' && row.kind !== 'lifecycle-batch') {
        continue
      }
      const superseded = contributions(row).every((contribution) => {
        const id = resolve(contribution.itemId)
        const bounds = touches.get(id)
        // First/latest cursor touches stay, including stale latest touches and shared siblings.
        if (bounds?.first === entry.seq || bounds?.last === entry.seq || !witnessed.has(id)) {
          return false
        }
        const current = saved.items.get(id)
        if (current) {
          // Equal revisions, including duplicate settlements, retain their cursor touch.
          return contribution.revision < current.revision
        }
        const removed = saved.tombstones.get(id)
        // Keep the current removal witness even when it is nested in a batch.
        return (
          removed !== undefined &&
          contribution.revision <= removed &&
          !(contribution.kind === 'tombstone' && contribution.revision === removed)
        )
      })
      if (superseded) {
        obsolete.push(entry.seq)
      }
    }
    for (let start = 0; start < obsolete.length; start += DELETE_ROWS) {
      if ((await pace()) !== database) {
        return null
      }
      // No catch here: native transaction failures must abort the pass, never autocommit a retry.
      deleted += database.transaction((db) => {
        const remove = db.prepare(`DELETE FROM journal_rows
          WHERE session_id = ? AND epoch = ? AND seq = ?
            AND EXISTS (SELECT 1 FROM journal_sessions s JOIN journal_state c
              ON c.session_id = s.session_id AND c.epoch = s.epoch
              WHERE s.session_id = journal_rows.session_id AND s.epoch = journal_rows.epoch
                AND c.through_seq >= journal_rows.seq)
            AND seq < (SELECT MAX(r.seq) FROM journal_rows r
              WHERE r.session_id = journal_rows.session_id AND r.epoch = journal_rows.epoch)`)
        // The epoch's last row stays even when its contribution is otherwise superseded.
        return obsolete
          .slice(start, start + DELETE_ROWS)
          .reduce((count, seq) => count + Number(remove.run(sessionId, epoch, seq).changes), 0)
      }, true)
    }
    const last = page.at(-1)
    if (!last || last.seq >= saved.lastSequence || page.length < PAGE_ROWS) {
      return deleted
    }
    after = last.seq
  }
}

/** Older files without incremental auto_vacuum retain free pages for reuse. */
export async function reclaimJournalPages(pace: JournalMaintenancePace): Promise<boolean> {
  const database = await pace()
  if (!database) {
    return false
  }
  if (Number(database.db.pragma('auto_vacuum', { simple: true })) !== 2) {
    return true
  }
  for (;;) {
    if ((await pace()) !== database) {
      return false
    }
    const free = Number(database.db.pragma('freelist_count', { simple: true }))
    if (free === 0) {
      return true
    }
    database.transaction((db) => db.pragma(`incremental_vacuum(${Math.min(free, 256)})`), true)
  }
}
