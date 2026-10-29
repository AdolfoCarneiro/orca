// A checkpoint is published whole on the FULL transaction path; rows remain the repair source.

import type Database from '../../sqlite/sync-database'
import type { JournalHostDatabase } from './journal-host-database'
import type { JournalReducerState } from './journal-reducer'
import { readJournalSessionEpoch } from './journal-row-table'
import {
  decodeJournalState,
  encodeJournalState,
  JOURNAL_STATE_CODEC_VERSION
} from './journal-state-codec'

export function ensureJournalSavedStateTables(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS journal_state (
    session_id TEXT PRIMARY KEY,
    epoch TEXT NOT NULL,
    through_seq INTEGER NOT NULL,
    version INTEGER NOT NULL,
    state_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS journal_items (
    session_id TEXT NOT NULL,
    epoch TEXT NOT NULL,
    item_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    item_json TEXT NOT NULL,
    PRIMARY KEY (session_id, epoch, item_id)
  )`)
}

export function readJournalSavedState(
  db: Database.Database,
  sessionId: string,
  epoch: string
): JournalReducerState | null {
  const row = db
    .prepare(`SELECT through_seq, version, state_json FROM journal_state
    WHERE session_id = ? AND epoch = ?`)
    .get(sessionId, epoch)
  if (!row || typeof row.version !== 'number' || typeof row.state_json !== 'string') {
    return null
  }
  try {
    const items = db
      .prepare(`SELECT item_json FROM journal_items
      WHERE session_id = ? AND epoch = ? ORDER BY ordinal`)
      .all(sessionId, epoch)
    const jsons = items.map((item) => {
      if (typeof item.item_json !== 'string') {
        throw new Error('invalid saved journal item')
      }
      return item.item_json
    })
    const state = decodeJournalState(row.version, row.state_json, jsons)
    return state?.sessionId === sessionId &&
      state.epoch === epoch &&
      state.lastSequence === row.through_seq
      ? state
      : null
  } catch (error) {
    logJournalCheckpointFailure(sessionId, error)
    return null
  }
}

/** Caller owns this chat's write lane; stale background folds may only advance the live epoch. */
export function saveJournalState(
  database: JournalHostDatabase,
  state: JournalReducerState
): boolean {
  if (database.readOnly || database.isClosed || state.lastSequence === 0) {
    return false
  }
  try {
    const encoded = encodeJournalState(state)
    return database.transaction((db) => {
      if (readJournalSessionEpoch(db, state.sessionId) !== state.epoch) {
        return false
      }
      const previous = db
        .prepare('SELECT epoch, through_seq FROM journal_state WHERE session_id = ?')
        .get(state.sessionId)
      if (previous?.epoch === state.epoch && Number(previous.through_seq) >= state.lastSequence) {
        return false
      }
      clearJournalSavedState(db, state.sessionId)
      const insert = db.prepare(`INSERT INTO journal_items
        (session_id, epoch, item_id, ordinal, item_json) VALUES (?, ?, ?, ?, ?)`)
      for (const item of encoded.items) {
        insert.run(state.sessionId, state.epoch, item.itemId, item.ordinal, item.itemJson)
      }
      db.prepare(`INSERT INTO journal_state (session_id, epoch, through_seq, version, state_json)
        VALUES (?, ?, ?, ?, ?)`).run(
        state.sessionId,
        state.epoch,
        state.lastSequence,
        JOURNAL_STATE_CODEC_VERSION,
        encoded.stateJson
      )
      return true
    })
  } catch (error) {
    logJournalCheckpointFailure(state.sessionId, error)
    return false
  }
}

/** Epoch publishers call this inside their row/epoch transaction. */
export function clearJournalSavedState(db: Database.Database, sessionId: string): void {
  db.prepare('DELETE FROM journal_items WHERE session_id = ?').run(sessionId)
  db.prepare('DELETE FROM journal_state WHERE session_id = ?').run(sessionId)
}

export function sweepJournalSavedState(database: JournalHostDatabase): void {
  database.transaction((db) => {
    for (const table of ['journal_items', 'journal_state']) {
      db.exec(`DELETE FROM ${table} WHERE NOT EXISTS (
        SELECT 1 FROM journal_sessions s WHERE s.session_id = ${table}.session_id
          AND s.epoch = ${table}.epoch
      )`)
    }
  })
}

export function logJournalCheckpointFailure(sessionId: string, error: unknown): void {
  console.warn('[agent-session-journal] could not save chat state', { sessionId, error })
}
