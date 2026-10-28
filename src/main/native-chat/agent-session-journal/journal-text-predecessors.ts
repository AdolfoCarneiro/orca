import type Database from '../../sqlite/sync-database'
import { parseJournalRow, serializeJournalRow, type JournalRow } from './journal-row-schema'

type TextPredecessor = {
  epoch: string
  seq: number
  revision: number
  role: string
  blanked: string
}

type TextPredecessors = { epoch: string | null; items: Map<string, TextPredecessor> }
type StagedTextPredecessors = {
  epoch: string | null
  items: Map<string, TextPredecessor | null>
}

function predecessor(row: JournalRow): TextPredecessor | null {
  if (
    row.kind !== 'item' ||
    row.body.kind !== 'message' ||
    (row.body.role !== 'assistant' && row.body.role !== 'reasoning') ||
    !row.body.blocks.every((block) => block.type === 'text')
  ) {
    return null
  }
  const blanked = serializeJournalRow({
    ...row,
    body: {
      ...row.body,
      blocks: row.body.blocks.map((block) => ({ ...block, text: '' }))
    }
  })
  // Validate without upcasting the stored version or discarding annotations.
  if (!parseJournalRow(blanked).ok) {
    return null
  }
  return {
    epoch: row.epoch,
    seq: row.seq,
    revision: row.revision,
    role: row.body.role,
    blanked
  }
}

/** Predecessors become visible only after their transaction commits. */
export class JournalTextPredecessors {
  private saved: TextPredecessors = { epoch: null, items: new Map() }

  constructor(private readonly sessionId: string) {}

  stage(db: Database.Database, rows: readonly JournalRow[]): StagedTextPredecessors {
    const staged: StagedTextPredecessors = { epoch: this.saved.epoch, items: new Map() }
    for (const row of rows) {
      if (row.epoch !== staged.epoch) {
        staged.items.clear()
        staged.epoch = row.epoch
      }
      if (row.kind !== 'item') {
        continue
      }
      const key = JSON.stringify([row.epoch, row.itemId])
      const previous = staged.items.has(key)
        ? staged.items.get(key)
        : row.epoch === this.saved.epoch
          ? this.saved.items.get(key)
          : undefined
      const next = predecessor(row)
      staged.items.set(key, null)
      if (!next) {
        continue
      }
      if (previous && previous.role === next.role && previous.revision < next.revision) {
        try {
          const result = db
            .prepare(`UPDATE journal_rows SET row_json = ?
            WHERE session_id = ? AND epoch = ? AND seq = ? AND json_extract(row_json, '$.itemId') = ?
              AND json_extract(row_json, '$.revision') = ?`)
            .run(
              previous.blanked,
              this.sessionId,
              previous.epoch,
              previous.seq,
              row.itemId,
              previous.revision
            )
          // A mismatched predecessor must never prevent the successor from committing.
          if (result.changes !== 1) {
            staged.items.set(key, next)
            continue
          }
        } catch {
          // Retention is optional; a failed rewrite must not fail the journal queue.
        }
      }
      staged.items.set(key, next)
    }
    return staged
  }

  committed(staged: StagedTextPredecessors): void {
    if (staged.epoch !== this.saved.epoch) {
      this.saved = { epoch: staged.epoch, items: new Map() }
    }
    for (const [key, value] of staged.items) {
      if (value) {
        this.saved.items.set(key, value)
      } else {
        this.saved.items.delete(key)
      }
    }
  }
}
