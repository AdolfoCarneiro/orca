import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session-journal-types'
import type { JournalHostDatabase } from './journal-host-database'
import type { JournalRow } from './journal-row-schema'
import { JournalRowWriter } from './journal-row-writer'
import { JournalWriteQueue } from './journal-write-queue'
import { readJournalRowsAfter } from './journal-row-table'
import {
  openTestJournalHostDatabase,
  readTestJournalRows,
  insertTestJournalRow,
  publishTestJournalEpoch
} from './journal-host-database-test-support'

export function registerJournalRowWriterTests(): void {
  const SESSION_ID = 'session-1'
  const EPOCH = 'epoch-1'

  function row(seq: number, ts: number): JournalRow {
    return {
      v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
      epoch: EPOCH,
      seq,
      fence: 0,
      ts,
      kind: 'item',
      itemId: 'item-1',
      revision: 1,
      body: { kind: 'status', text: 'plain append' }
    }
  }

  describe('journal row writer', () => {
    let root: string
    let database: JournalHostDatabase
    let readOnly = false

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), 'orca-journal-row-writer-'))
      database = openTestJournalHostDatabase(root)
      publishTestJournalEpoch(database.db, SESSION_ID, EPOCH)
      readOnly = false
    })

    afterEach(async () => {
      vi.restoreAllMocks()
      try {
        database.close()
      } catch {}
      await rm(root, { recursive: true, force: true })
    })

    function writerHarness() {
      const committedRows: JournalRow[] = []
      let sequence = 1
      const queue = new JournalWriteQueue(SESSION_ID)
      const writer = new JournalRowWriter({
        sessionId: SESSION_ID,
        now: () => 1,
        serialize: (run) => queue.serialize(run),
        database: () => database,
        readOnly: () => readOnly,
        highestFence: () => 0,
        nextSequence: () => sequence,
        commit: (committed) => {
          committedRows.push(...committed)
          sequence = committed.at(-1)!.seq + 1
        }
      })
      return { writer, committedRows }
    }

    function textRow(seq: number, itemId = 'text', revision = seq): JournalRow {
      return {
        ...row(seq, 0),
        v: 2,
        kind: 'item',
        itemId,
        revision,
        body: {
          kind: 'message',
          role: 'reasoning',
          state: 'running',
          blocks: [{ type: 'text', text: 'saved text' }]
        }
      }
    }

    it.each(['single', 'batch'] as const)(
      'blanks only the previous text in a %s write',
      async (kind) => {
        const { writer } = writerHarness()
        const write = (build: (seq: number) => JournalRow) =>
          kind === 'single' ? writer.enqueue(build) : writer.enqueueRows(() => [build])
        await write((seq) => textRow(seq))
        const before = readJournalRowsAfter(database.db, SESSION_ID, EPOCH, 0)[0]
        await write((seq) => textRow(seq))
        if (kind === 'batch') {
          await writer.enqueueRows(() => [(seq) => textRow(seq), (seq) => textRow(seq)])
        }
        const saved = readJournalRowsAfter(database.db, SESSION_ID, EPOCH, 0)
        const blanked = JSON.parse(before.rowJson)
        blanked.body.blocks[0].text = ''
        expect(saved[0]).toEqual({ ...before, rowJson: JSON.stringify(blanked) })
        expect(
          saved.slice(0, -1).every((entry) => JSON.parse(entry.rowJson).body.blocks[0].text === '')
        ).toBe(true)
        expect(JSON.parse(saved.at(-1)!.rowJson).body.blocks[0].text).toBe('saved text')
      }
    )

    it('does not publish rolled-back predecessors when their sequence is reused', async () => {
      const { writer } = writerHarness()
      await writer.enqueue((seq) => textRow(seq))
      const exec = database.db.exec.bind(database.db)
      const spy = vi.spyOn(database.db, 'exec').mockImplementationOnce((sql) => exec(sql))
      spy.mockImplementation((sql) => {
        if (sql === 'COMMIT') {
          throw new Error('commit failed')
        }
        exec(sql)
      })
      await expect(writer.enqueue((seq) => textRow(seq))).rejects.toThrow('commit failed')
      spy.mockRestore()
      await writer.enqueue((seq) => textRow(seq, 'other'))
      await writer.enqueue((seq) => textRow(seq))
      const saved = readJournalRowsAfter(database.db, SESSION_ID, EPOCH, 0).map((entry) =>
        JSON.parse(entry.rowJson)
      )
      expect(saved.map((entry) => entry.body.blocks[0].text)).toEqual([
        '',
        'saved text',
        'saved text'
      ])
      expect(saved[1].itemId).toBe('other')
    })

    it('skips mismatched or refused rewrites and never targets a retired epoch', async () => {
      const { writer } = writerHarness()
      await writer.enqueue((seq) => textRow(seq))
      database.db
        .prepare(
          "UPDATE journal_rows SET row_json = json_set(row_json, '$.itemId', 'other') WHERE seq = 1"
        )
        .run()
      await writer.enqueue((seq) => textRow(seq))
      database.db.exec(
        "CREATE TRIGGER refuse_blanking BEFORE UPDATE ON journal_rows BEGIN SELECT RAISE(ABORT, 'refused'); END"
      )
      await writer.enqueue((seq) => textRow(seq))
      expect(readJournalRowsAfter(database.db, SESSION_ID, EPOCH, 0)).toHaveLength(3)
      database.db.exec('DROP TRIGGER refuse_blanking')
      await writer.enqueue((seq) => ({ ...textRow(seq), epoch: 'epoch-2' }))
      expect(
        readJournalRowsAfter(database.db, SESSION_ID, EPOCH, 0).map(
          (entry) => JSON.parse(entry.rowJson).body.blocks[0].text
        )
      ).toEqual(['saved text', 'saved text', 'saved text'])
      expect(readJournalRowsAfter(database.db, SESSION_ID, 'epoch-2', 0)).toHaveLength(1)
    })

    it('rolls the transaction back and sets no latch when the insert fails', async () => {
      const { writer, committedRows } = writerHarness()
      insertTestJournalRow(database.db, SESSION_ID, row(1, 1))

      await expect(writer.enqueue(row)).rejects.toThrow()

      expect(readOnly).toBe(false)
      expect(committedRows).toHaveLength(0)
      expect(readTestJournalRows(database.db, SESSION_ID, EPOCH)).toHaveLength(1)
      // Rolled-back inserts leave the writer usable.
      await expect(writer.enqueue((seq, ts) => row(seq + 1, ts))).resolves.toMatchObject({
        kind: 'item'
      })
    })

    it('writes several rows as one: a failure on the last leaves none', async () => {
      const { writer, committedRows } = writerHarness()
      insertTestJournalRow(database.db, SESSION_ID, row(2, 1))

      await expect(writer.enqueueRows(() => [row, row])).rejects.toThrow()

      expect(committedRows).toHaveLength(0)
      expect(
        readTestJournalRows(database.db, SESSION_ID, EPOCH).map((stored) => stored.seq)
      ).toEqual([2])
    })

    it.each(['single', 'batch'] as const)(
      'keeps the save time separate from a pinned JSON timestamp in a %s write',
      async (kind) => {
        const { writer, committedRows } = writerHarness()
        const pinned = (seq: number) => row(seq, 0)
        await (kind === 'single'
          ? writer.enqueue(pinned)
          : writer.enqueueRows(() => [pinned, pinned]))

        const saved = readJournalRowsAfter(database.db, SESSION_ID, EPOCH, 0)
        expect(saved).toHaveLength(kind === 'single' ? 1 : 2)
        expect(saved.map((entry) => entry.ts)).toEqual(saved.map(() => 1))
        expect(saved.map((entry) => JSON.parse(entry.rowJson))).toEqual(committedRows)
        expect(committedRows.map((entry) => entry.ts)).toEqual(saved.map(() => 0))
      }
    )
  })
}
