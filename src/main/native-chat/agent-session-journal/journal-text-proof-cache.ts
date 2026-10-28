import { randomUUID } from 'node:crypto'
import type Database from '../../sqlite/sync-database'
import { journalDatabasePath, type JournalHostDatabase } from './journal-host-database'
import {
  readJournalTextRow,
  validateJournalTextRow,
  type JournalTextRowProof,
  type JournalTextRowQuery
} from './journal-text-validation'
import { validateJournalTextViaWorker } from './journal-text-validation-client'

export const JOURNAL_TEXT_PRUNE_BYTES = 256 * 1024
const INLINE_ROW_BYTES = 64 * 1024
const MAX_PROOFS = 256

type Proof = {
  token: string
  query: JournalTextRowQuery
  value?: JournalTextRowProof
  failed?: true
}

// TEMP guards observe receipts/triggers on this connection; data_version covers every other writer.
const GUARDS = `
CREATE TEMP TABLE IF NOT EXISTS journal_text_proofs (
  token TEXT PRIMARY KEY, session_id TEXT NOT NULL, epoch TEXT NOT NULL, seq INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS temp.journal_text_proof_rows ON journal_text_proofs(session_id, epoch, seq);
CREATE TEMP TRIGGER IF NOT EXISTS journal_text_proof_insert AFTER INSERT ON main.journal_rows BEGIN
  DELETE FROM journal_text_proofs WHERE session_id = NEW.session_id AND epoch = NEW.epoch AND seq = NEW.seq;
END;
CREATE TEMP TRIGGER IF NOT EXISTS journal_text_proof_delete AFTER DELETE ON main.journal_rows BEGIN
  DELETE FROM journal_text_proofs WHERE session_id = OLD.session_id AND epoch = OLD.epoch AND seq = OLD.seq;
END;
CREATE TEMP TRIGGER IF NOT EXISTS journal_text_proof_update AFTER UPDATE ON main.journal_rows BEGIN
  DELETE FROM journal_text_proofs WHERE session_id = OLD.session_id AND epoch = OLD.epoch AND seq = OLD.seq;
  DELETE FROM journal_text_proofs WHERE session_id = NEW.session_id AND epoch = NEW.epoch AND seq = NEW.seq;
END;
`

/** Only compact evidence survives a turn; no text bodies or hashes are cached or compared. */
export class JournalTextProofCache {
  private readonly entries = new Map<string, Proof>()
  private versions = ''
  private remaining = 0
  private readonly abort = new AbortController()
  pending: Promise<void> | null = null

  constructor(private readonly database: JournalHostDatabase) {}

  /** Call under BEGIN IMMEDIATE, before consuming any evidence. */
  begin(db: Database.Database): void {
    const versions = this.stamp(db)
    if (this.versions !== versions) {
      db.exec(GUARDS)
      this.clear(db)
      this.versions = this.stamp(db)
    }
    this.remaining = JOURNAL_TEXT_PRUNE_BYTES
  }

  read(db: Database.Database, query: JournalTextRowQuery): JournalTextRowProof | null {
    const key = JSON.stringify(query)
    const previous = this.entries.get(key)
    if (previous) {
      if (
        !previous.failed &&
        db.prepare('SELECT 1 FROM temp.journal_text_proofs WHERE token = ?').get(previous.token)
      ) {
        this.entries.delete(key)
        this.entries.set(key, previous)
        return previous.value ?? null
      }
      this.remove(db, key, previous)
    }
    // octet_length reads the record header, including for overflow TEXT, without scanning its bytes.
    const size = db
      .prepare(
        'SELECT octet_length(row_json) AS bytes FROM journal_rows WHERE session_id = ? AND epoch = ? AND seq = ?'
      )
      .get(query.sessionId, query.epoch, query.seq)?.bytes
    if (typeof size !== 'number') {
      throw new Error('journal_text_prune_row_missing')
    }
    if (size <= INLINE_ROW_BYTES && size > this.remaining) {
      return null
    }
    if (this.entries.size >= MAX_PROOFS) {
      const oldest = this.entries.entries().next().value
      if (oldest) {
        this.remove(db, oldest[0], oldest[1])
      }
    }
    const proof: Proof = { token: randomUUID(), query }
    db.prepare(
      'INSERT INTO temp.journal_text_proofs (token, session_id, epoch, seq) VALUES (?, ?, ?, ?)'
    ).run(proof.token, query.sessionId, query.epoch, query.seq)
    this.entries.set(key, proof)
    if (size <= INLINE_ROW_BYTES) {
      this.remaining -= size
      proof.value = validateJournalTextRow(readJournalTextRow(db, query), query)
      return proof.value
    }
    this.pending = validateJournalTextViaWorker(
      journalDatabasePath(this.database.stateDirectory),
      query,
      this.abort.signal
    )
      .then((response) => {
        if (!response.ok) {
          throw new Error(response.error)
        }
        proof.value = response.proof
      })
      .catch((error: unknown) => {
        proof.failed = true
        throw error
      })
      .finally(() => {
        this.pending = null
      })
    return null
  }

  assertCurrent(db: Database.Database, queries: readonly JournalTextRowQuery[]): void {
    for (const query of queries) {
      const proof = this.entries.get(JSON.stringify(query))
      if (
        !proof ||
        !db.prepare('SELECT 1 FROM temp.journal_text_proofs WHERE token = ?').get(proof.token)
      ) {
        throw new Error('journal_text_prune_support_changed')
      }
    }
  }

  retired(sequences: readonly number[]): void {
    const retired = new Set(sequences)
    for (const [key, proof] of this.entries) {
      if (retired.has(proof.query.seq)) {
        this.entries.delete(key)
      }
    }
  }

  close(): void {
    this.abort.abort()
    if (!this.database.isClosed) {
      const db = this.database.db
      // The first cleanup transaction may have rolled back the TEMP table creation too.
      if (
        db
          .prepare(
            "SELECT 1 FROM sqlite_temp_master WHERE type = 'table' AND name = 'journal_text_proofs'"
          )
          .get()
      ) {
        this.clear(db)
      }
    }
    this.entries.clear()
  }

  private stamp(db: Database.Database): string {
    return ['data_version', 'schema_version', 'temp.schema_version']
      .map((name) => db.pragma(name, { simple: true }))
      .join(':')
  }

  private clear(db: Database.Database): void {
    for (const [key, proof] of this.entries) {
      this.remove(db, key, proof)
    }
  }

  private remove(db: Database.Database, key: string, proof: Proof): void {
    db.prepare('DELETE FROM temp.journal_text_proofs WHERE token = ?').run(proof.token)
    this.entries.delete(key)
  }
}
