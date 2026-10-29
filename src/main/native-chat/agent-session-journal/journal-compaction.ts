// The checkpoint owns current values; retained first/latest touches keep catch-up complete.

import { isDeepStrictEqual } from 'node:util'
import { startJournalRowFold } from './journal-open'
import { encodeJournalState } from './journal-state-codec'
import type { JournalReducerState } from './journal-reducer'
import type { JournalHostDatabase } from './journal-host-database'
import { readJournalRowsAfter, readJournalSessionEpoch } from './journal-row-table'
import { isJournalStopOrResumeRow, parseJournalRow, type JournalRow } from './journal-row-schema'
import { logJournalCheckpointFailure, readJournalSavedState } from './journal-saved-state'

export type JournalMaintenancePace = () => Promise<JournalHostDatabase | null>

const PAGE_ROWS = 32
const DELETE_ROWS = 8

function contributions(row: JournalRow): { itemId: string }[] {
  if (row.kind === 'lifecycle-batch') {
    return row.mutations
  }
  return row.kind === 'item' || (row.kind === 'tombstone' && !isJournalStopOrResumeRow(row))
    ? [row]
    : []
}

function durableState(state: JournalReducerState): unknown {
  const encoded = encodeJournalState(state)
  return {
    state: JSON.parse(encoded.stateJson),
    items: encoded.items.map(({ itemId, ordinal, itemJson }) => ({
      itemId,
      ordinal,
      item: JSON.parse(itemJson)
    }))
  }
}

/** Validate the entire retained prefix before deleting anything; saved-prefix gaps are normal. */
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
  const active = async (): Promise<boolean> =>
    (await pace()) === database &&
    !database.isClosed &&
    readJournalSessionEpoch(database.db, sessionId) === epoch
  const touches = new Map<string, { first: number; last: number }>()
  let expected = 1
  let complete = true
  let founded = false
  const resolve = (id: string): string => saved.aliases.get(id) ?? id
  let validatedThrough: number | null = null
  for (;;) {
    if (!(await active())) {
      return null
    }
    // Inspect physical SQL rows before the normal reader can omit malformed storage values.
    const query = database.db.prepare(`SELECT seq, ts, row_json FROM journal_rows
      WHERE session_id = ? AND epoch = ? AND seq <= ?
      ${validatedThrough === null ? '' : 'AND seq > ?'} ORDER BY seq ASC LIMIT ?`)
    const page =
      validatedThrough === null
        ? query.all(sessionId, epoch, saved.lastSequence, PAGE_ROWS)
        : query.all(sessionId, epoch, saved.lastSequence, validatedThrough, PAGE_ROWS)
    for (const entry of page) {
      if (
        typeof entry.seq !== 'number' ||
        typeof entry.ts !== 'number' ||
        !Number.isFinite(entry.ts) ||
        typeof entry.row_json !== 'string'
      ) {
        return 0
      }
      const parsed = parseJournalRow(entry.row_json)
      // An unreadable retained row parks this whole chat, including candidates preceding it.
      if (
        !parsed.ok ||
        !Number.isSafeInteger(entry.seq) ||
        entry.seq < 1 ||
        parsed.row.seq !== entry.seq ||
        parsed.row.epoch !== epoch ||
        (entry.seq === 1 && parsed.row.kind !== 'epoch')
      ) {
        return 0
      }
      founded ||= entry.seq === 1
      complete &&= entry.seq === expected
      expected = entry.seq + 1
      validatedThrough = entry.seq
      for (const contribution of contributions(parsed.row)) {
        const id = resolve(contribution.itemId)
        touches.set(id, { first: touches.get(id)?.first ?? entry.seq, last: entry.seq })
      }
    }
    if (
      validatedThrough === null ||
      validatedThrough >= saved.lastSequence ||
      page.length < PAGE_ROWS
    ) {
      break
    }
  }

  if (!founded) {
    return 0
  }
  complete &&= expected === saved.lastSequence + 1
  let needsComparison = complete
  const validateCheckpoint = async (): Promise<boolean | null> => {
    const fold = startJournalRowFold({ sessionId, epoch })
    let cursor = Number.MIN_SAFE_INTEGER
    while (cursor < saved.lastSequence) {
      if (!(await active())) {
        return null
      }
      const page = readJournalRowsAfter(database.db, sessionId, epoch, cursor, PAGE_ROWS)
      for (const entry of page) {
        if (entry.seq > saved.lastSequence) {
          break
        }
        if (!fold.add(entry)) {
          break
        }
      }
      const last = page.at(-1)
      if (!last || last.seq >= saved.lastSequence || page.length < PAGE_ROWS) {
        break
      }
      cursor = last.seq
    }
    const loaded = fold.finish()
    if (
      loaded.damage ||
      loaded.newer ||
      loaded.state.lastSequence !== saved.lastSequence ||
      !isDeepStrictEqual(durableState(loaded.state), durableState(saved))
    ) {
      logJournalCheckpointFailure(
        sessionId,
        new Error('Saved chat state differs from its complete journal prefix')
      )
      return false
    }
    return true
  }

  let deleted = 0
  let after = Number.MIN_SAFE_INTEGER
  for (;;) {
    if (!(await active())) {
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
        // A sibling's first/latest touch pins its whole SQL row, even when its payload was ignored.
        return bounds !== undefined && bounds.first !== entry.seq && bounds.last !== entry.seq
      })
      if (superseded) {
        obsolete.push(entry.seq)
      }
    }
    if (obsolete.length > 0 && needsComparison) {
      const valid = await validateCheckpoint()
      if (valid !== true) {
        return valid === null ? null : 0
      }
      needsComparison = false
    }
    for (let start = 0; start < obsolete.length; start += DELETE_ROWS) {
      if (!(await active())) {
        return null
      }
      // No catch here: native transaction failures must abort the pass, never autocommit a retry.
      deleted += database.transaction((db) => {
        const remove = db.prepare(`DELETE FROM journal_rows
          WHERE session_id = ? AND epoch = ? AND seq = ?
            AND EXISTS (SELECT 1 FROM journal_sessions s JOIN journal_state c
              ON c.session_id = s.session_id AND c.epoch = s.epoch
              WHERE s.session_id = journal_rows.session_id AND s.epoch = journal_rows.epoch
                AND c.through_seq >= ?)
            AND seq < (SELECT MAX(r.seq) FROM journal_rows r
              WHERE r.session_id = journal_rows.session_id AND r.epoch = journal_rows.epoch)`)
        // The epoch's last row stays even when its contribution is otherwise superseded.
        return obsolete
          .slice(start, start + DELETE_ROWS)
          .reduce(
            (count, seq) =>
              count + Number(remove.run(sessionId, epoch, seq, saved.lastSequence).changes),
            0
          )
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
