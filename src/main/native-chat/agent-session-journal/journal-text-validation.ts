import type Database from '../../sqlite/sync-database'
import { parseJournalRow, type JournalRow } from './journal-row-schema'
import { journalTextFields, journalWholeItem } from './journal-text-rows'

export type JournalTextRowQuery = {
  sessionId: string
  epoch: string
  seq: number
  itemId?: string
  field?: number
  revision?: number
  settlementId?: string
}

export type JournalTextRowProof = {
  kind: JournalRow['kind']
  v: number
  boundary: boolean
  itemRevision: number | null
  hasField: boolean
  settlementMatches: boolean
  deltaRevision: number | null
  deltaMatches: boolean
}

export type JournalTextValidationRequest = {
  id: number
  kind: 'journalTextValidation'
  dbPath: string
  query: JournalTextRowQuery
}

export type JournalTextValidationResponse =
  | { id: number; ok: true; proof: JournalTextRowProof; bytes: number }
  | { id: number; ok: false; error: string; unavailable?: true }

/** Both lanes use the full reader before reducing the result to constant-size evidence. */
export function validateJournalTextRow(
  json: string,
  query: JournalTextRowQuery
): JournalTextRowProof {
  const parsed = parseJournalRow(json, true)
  if (!parsed.ok || parsed.row.seq !== query.seq || parsed.row.epoch !== query.epoch) {
    throw new Error('journal_text_prune_row_invalid')
  }
  const row = parsed.row
  const item =
    query.itemId !== undefined && (row.kind === 'item' || row.kind === 'lifecycle-batch')
      ? journalWholeItem(row, query.itemId, query.revision)
      : undefined
  return {
    kind: row.kind,
    v: row.v,
    boundary: row.kind === 'item' && row.v >= 5 && journalTextFields(row.body).length > 0,
    itemRevision: item?.revision ?? null,
    hasField: !!item && journalTextFields(item.body).includes(query.field ?? -1),
    settlementMatches: row.kind !== 'lifecycle-batch' || row.settlementId === query.settlementId,
    deltaRevision: row.kind === 'text-delta' ? row.revision : null,
    deltaMatches:
      row.kind === 'text-delta' && row.itemId === query.itemId && row.field === query.field
  }
}

export function readJournalTextRow(db: Database.Database, query: JournalTextRowQuery): string {
  const stored = db
    .prepare('SELECT row_json FROM journal_rows WHERE session_id = ? AND epoch = ? AND seq = ?')
    .get(query.sessionId, query.epoch, query.seq)
  if (typeof stored?.row_json !== 'string') {
    throw new Error('journal_text_prune_row_missing')
  }
  return stored.row_json
}
