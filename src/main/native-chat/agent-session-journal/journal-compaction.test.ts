import { statSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import { projectJournalBatch } from '../agent-session-wire/agent-session-journal-batch'
import { compactJournalSession, reclaimJournalPages } from './journal-compaction'
import { journalDatabasePath, type JournalHostDatabase } from './journal-host-database'
import {
  closeTestJournalHostDatabases,
  insertTestJournalRow,
  liveTestJournalRows,
  openTestJournalHostDatabase,
  publishTestJournalEpoch
} from './journal-host-database-test-support'
import { JournalLifecycleBatchAppender } from './journal-lifecycle-batch-appender'
import { readJournalRowsAfterCursor, replayJournal, restoreJournal } from './journal-open'
import { journalPayload } from './journal-payload-bounds'
import {
  applyJournalRow,
  createJournalReducerState,
  renderJournalState,
  type JournalReducerState
} from './journal-reducer'
import type { JournalItemRow, JournalRow } from './journal-row-schema'
import { readJournalSavedState, saveJournalState } from './journal-saved-state'
import { backfillJournalState, startJournalStateBackfill } from './journal-state-backfill'

const sessionId = 'session'
const epoch = 'epoch'
const providerHandle = { kind: 'codex', threadId: 'thread' } as const
const base = (seq: number) => ({ v: 4, epoch, seq, fence: 1, ts: 1_000 + seq })
const text = (value: string): AgentJournalMessageItem => ({
  kind: 'message',
  role: 'assistant',
  blocks: [{ type: 'text', text: value }]
})
const item = (seq: number, revision: number, itemId = 'reply'): JournalItemRow => ({
  ...base(seq),
  kind: 'item',
  itemId,
  revision,
  body: text(`revision ${revision}`)
})
let root: string
let database: JournalHostDatabase
let state: JournalReducerState
const pace = async () => database
const stored = () => liveTestJournalRows(database.db, sessionId)
const compact = () => compactJournalSession(database, sessionId, epoch, pace)
const run = () => ({
  database: () => database,
  checkpointOpen: async () => false,
  stopped: () => false,
  rest: async () => {}
})

function append(rows: readonly JournalRow[]): void {
  database.transaction((db) => {
    for (const row of rows) {
      insertTestJournalRow(db, sessionId, row)
    }
  })
  for (const row of rows) {
    applyJournalRow(state, row)
  }
}

function expectSameState(actual: JournalReducerState | null | undefined): void {
  if (!actual) {
    throw new Error('missing restored state')
  }
  expect(Object.keys(actual)).toEqual(Object.keys(state))
  const fields: Record<string, unknown> = { ...actual }
  for (const [key, expected] of Object.entries(state)) {
    const value = fields[key]
    if (
      (value instanceof Map && expected instanceof Map) ||
      (value instanceof Set && expected instanceof Set)
    ) {
      expect([...value]).toStrictEqual([...expected])
    } else if (key === 'queue') {
      expect([...actual.queue.cards]).toStrictEqual([...state.queue.cards])
      expect(actual.queue.revision).toBe(state.queue.revision)
    } else if (key === 'derivedTurnScope') {
      expect(actual.derivedTurnScope.snapshot()).toBe(state.derivedTurnScope.snapshot())
    } else {
      expect(value).toStrictEqual(expected)
    }
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-compaction-'))
  database = openTestJournalHostDatabase(root)
  state = createJournalReducerState(sessionId, epoch)
  publishTestJournalEpoch(database.db, sessionId, epoch)
})
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

it.each([0, 2])(
  'retires streamed text/tool copies and reclaims only incremental files (mode %s)',
  async (mode) => {
    database.db.pragma(`auto_vacuum = ${mode}`)
    database.db.exec('VACUUM')
    append([{ ...base(1), kind: 'epoch', reason: 'legacy_import', providerHandle }])
    const rows: JournalRow[] = []
    for (let revision = 1; revision <= 100; revision++) {
      rows.push(
        {
          ...base(2 * revision),
          kind: 'item',
          itemId: 'reply',
          revision,
          body: text('streaming '.repeat(revision * 20))
        },
        {
          ...base(2 * revision + 1),
          kind: 'item',
          itemId: 'tool',
          revision,
          body: {
            kind: 'tool-call',
            name: 'Bash',
            state: 'running',
            input: { command: 'build' },
            output: journalPayload('tool output '.repeat(revision * 10))
          }
        }
      )
    }
    rows.push(
      {
        ...base(202),
        kind: 'submission',
        clientMessageId: 'send',
        payloadFingerprint: 'fp',
        body: { kind: 'message', role: 'user', blocks: [] },
        providerHandle,
        handoverRecorded: true
      },
      {
        ...base(203),
        kind: 'dispatch',
        clientMessageId: 'send',
        state: 'pending',
        providerItemId: null,
        reason: null
      }
    )
    append(rows)
    expect(saveJournalState(database, state)).toBe(true)
    // Two revisions outside the checkpoint must remain contiguous and untouched.
    append([item(204, 101), item(205, 102)])
    const tail = stored().filter((row) => row.seq > 203)
    const snapshot = renderJournalState(state)
    const catchUp = () =>
      projectJournalBatch({
        rows: readJournalRowsAfterCursor(database.db, sessionId, epoch, 50),
        snapshot,
        afterSequence: 50
      })
    const before = catchUp()
    expect(before).toMatchObject({
      ok: true,
      batch: { submissions: [{ clientMessageId: 'send' }] }
    })
    database.db.pragma('wal_checkpoint(TRUNCATE)')
    const fileBefore = statSync(journalDatabasePath(root)).size
    expect(await compact()).toBe(196)
    expect(stored().map((row) => row.seq)).toEqual([1, 2, 3, 200, 201, 202, 203, 204, 205])
    expect(stored().filter((row) => row.seq > 203)).toEqual(tail)
    // Top-level residuals are exactly the first and checkpoint-current reply/tool copies.
    expect(
      stored()
        .filter((row) => [2, 3, 200, 201].includes(row.seq))
        .map((row) => [row.seq, Buffer.byteLength(row.rowJson)])
    ).toEqual([
      [2, 377],
      [3, 434],
      [200, 20181],
      [201, 12320]
    ])
    expectSameState(restoreJournal(database.db, sessionId)?.state)
    expect(catchUp()).toStrictEqual(before)
    expect(replayJournal(database.db, sessionId)?.damage?.cause).toBe('sequence-gap')
    const free = Number(database.db.pragma('freelist_count', { simple: true }))
    expect(free).toBeGreaterThan(0)
    expect(await reclaimJournalPages(pace)).toBe(true)
    database.db.pragma('wal_checkpoint(TRUNCATE)')
    if (mode === 2) {
      expect(Number(database.db.pragma('freelist_count', { simple: true }))).toBe(0)
      expect(statSync(journalDatabasePath(root)).size).toBeLessThan(fileBefore)
    } else {
      expect(Number(database.db.pragma('freelist_count', { simple: true }))).toBe(free)
      expect(statSync(journalDatabasePath(root)).size).toBe(fileBefore)
    }
  }
)

it('compacts another checkpoint after restart across the previous pass holes', async () => {
  append([
    { ...base(1), kind: 'epoch', reason: 'session_created', providerHandle },
    item(2, 1),
    item(3, 2),
    item(4, 3)
  ])
  expect(await backfillJournalState(run())).toEqual({ deleted: 1 })
  expect(stored().map((row) => row.seq)).toEqual([1, 2, 4])
  closeTestJournalHostDatabases()
  database = openTestJournalHostDatabase(root)
  const saved = readJournalSavedState(database.db, sessionId, epoch)
  if (!saved) {
    throw new Error('missing checkpoint after restart')
  }
  state = saved
  append([item(5, 4), item(6, 5), item(7, 6)])
  expect(saveJournalState(database, state)).toBe(true)
  expect(await backfillJournalState(run())).toEqual({ deleted: 3 })
  expect(stored().map((row) => row.seq)).toEqual([1, 2, 7])
  expectSameState(restoreJournal(database.db, sessionId)?.state)
})

it('retires producer batch finals and repeated batches while measuring whole-row exceptions', async () => {
  append([
    { ...base(1), kind: 'epoch', reason: 'session_created', providerHandle },
    { ...item(2, 1), body: text('P') },
    { ...item(3, 2), body: text('PT') }
  ])
  const appender = new JournalLifecycleBatchAppender({
    state: () => state,
    cursor: () => ({ epoch, sequence: state.lastSequence }),
    enqueueRows: async (plan) => {
      const start = state.lastSequence
      const rows = plan().map((build, index) => build(start + index + 1, 1_000 + start + index + 1))
      append(rows)
      return rows
    }
  })
  const mutation = (itemId: string) => ({
    kind: 'item' as const,
    itemId,
    body: text('PT'),
    turnScope: { kind: 'thread' as const }
  })
  const batch = (settlementId: string, ids: string[]) =>
    appender.append({
      settlementId,
      fence: 1,
      mutations: ids.map(mutation)
    })
  await batch('producer-final', ['reply'])
  await batch('shared-first', ['reply', 'other'])
  await batch('shared-latest', ['reply', 'other'])
  await batch('repeated', ['reply'])
  await batch('latest', ['reply'])
  append([
    {
      ...base(9),
      kind: 'lifecycle-batch',
      settlementId: 'latest',
      mutations: [{ kind: 'item', itemId: 'reply', revision: 7, body: text('PT') }]
    },
    {
      ...base(10),
      kind: 'tombstone',
      itemId: 'stop',
      revision: 1,
      stopEvent: { reason: 'user-stop', at: 1_010 }
    }
  ])
  expect(saveJournalState(database, state)).toBe(true)
  expect(await compact()).toBe(3)
  expect(stored().map((row) => row.seq)).toEqual([1, 2, 5, 6, 8, 9, 10])
  expectSameState(restoreJournal(database.db, sessionId)?.state)
  // Finite batch residuals: first sibling, current sibling, current item, duplicate current item.
  const exceptions = stored()
    .filter((row) => [5, 6, 8, 9].includes(row.seq))
    .map((row) => [row.seq, Buffer.byteLength(row.rowJson)])
  expect(exceptions).toEqual([
    [5, 470],
    [6, 471],
    [8, 289],
    [9, 244]
  ])
})

it.each(['{broken', '{"v":9999}', 'misnumbered'])(
  'skips the entire chat for an unreadable retained row: %s',
  async (damage) => {
    append([
      { ...base(1), kind: 'epoch', reason: 'session_created', providerHandle },
      item(2, 1),
      item(3, 2),
      item(4, 3)
    ])
    saveJournalState(database, state)
    const json = damage === 'misnumbered' ? JSON.stringify(item(44, 3)) : damage
    // Preserve the checkpoint to model damage discovered in an already saved prefix.
    database.db.prepare('UPDATE journal_rows SET row_json = ? WHERE seq = 4').run(json)
    const before = stored()
    expect(await compact()).toBe(0)
    expect(stored()).toEqual(before)
  }
)

it.each([false, true])(
  'requires retained current/removal witnesses and resolves saved aliases (removed: %s)',
  async (missingRemoved) => {
    append([
      { ...base(1), kind: 'epoch', reason: 'session_created', providerHandle },
      item(2, 1),
      item(3, 2),
      item(4, 1),
      item(5, 1, 'removed'),
      item(6, 2, 'removed'),
      {
        ...base(7),
        kind: 'lifecycle-batch',
        settlementId: 'remove',
        mutations: [{ kind: 'tombstone', itemId: 'removed', revision: 3 }]
      },
      item(8, 2, 'removed'),
      item(9, 1, 'missing'),
      item(10, 2, 'missing'),
      missingRemoved
        ? { ...base(11), kind: 'tombstone', itemId: 'missing', revision: 3 }
        : item(11, 3, 'missing'),
      item(12, 1, 'missing'),
      item(13, 1, 'canonical'),
      item(14, 2, 'canonical'),
      item(15, 3, 'canonical'),
      item(16, 2, 'removed')
    ])
    state.aliases.set('alias', 'canonical')
    saveJournalState(database, state)
    database.db.prepare('DELETE FROM journal_rows WHERE seq = 11').run()
    const aliased = item(15, 3, 'alias')
    database.db
      .prepare('UPDATE journal_rows SET row_json = ? WHERE seq = 15')
      .run(JSON.stringify(aliased))
    const catchUp = () =>
      projectJournalBatch({
        rows: readJournalRowsAfterCursor(database.db, sessionId, epoch, 3),
        snapshot: renderJournalState(state),
        afterSequence: 3,
        canonicalItemId: (id) => state.aliases.get(id) ?? id
      })
    const before = catchUp()
    // Stale reply revision 1 cannot replace revision 2; removed revision 2 cannot resurrect revision 3.
    expect(await compact()).toBe(3)
    expect(stored().map((row) => row.seq)).toEqual([1, 2, 3, 4, 5, 7, 9, 10, 12, 13, 15, 16])
    expect(catchUp()).toEqual(before)
    expectSameState(restoreJournal(database.db, sessionId)?.state)
    const bytes = (seq: number) =>
      Buffer.byteLength(stored().find((row) => row.seq === seq)?.rowJson ?? '')
    expect(bytes(4)).toBe(187) // Stale latest touch still belongs in catch-up.
    expect(bytes(7)).toBe(167) // Current removal batch witness.
    expect(bytes(16)).toBe(190) // The epoch's last row is retained.
    expect(bytes(10)).toBe(190) // Missing-current-witness exception retains this middle copy.
  }
)

it.each(['ABORT', 'ROLLBACK', 'COMMIT'])(
  'propagates native deletion %s failures without partially retiring the step',
  async (failure) => {
    append([
      { ...base(1), kind: 'epoch', reason: 'session_created', providerHandle },
      item(2, 1),
      item(3, 2),
      item(4, 3),
      item(5, 4)
    ])
    saveJournalState(database, state)
    const before = stored()
    if (failure === 'COMMIT') {
      database.db.exec(`CREATE TABLE retirement_parent (id INTEGER PRIMARY KEY);
      CREATE TABLE retirement_child (parent_id INTEGER REFERENCES retirement_parent(id)
        DEFERRABLE INITIALLY DEFERRED);
      CREATE TRIGGER fail_retirement BEFORE DELETE ON journal_rows WHEN old.seq = 4
        BEGIN INSERT INTO retirement_child VALUES (1); END`)
    } else {
      database.db.exec(`CREATE TRIGGER fail_retirement BEFORE DELETE ON journal_rows
      WHEN old.seq = 4 BEGIN SELECT RAISE(${failure}, 'retirement failed'); END`)
    }
    await expect(backfillJournalState(run())).rejects.toThrow(
      failure === 'COMMIT' ? /FOREIGN KEY/i : 'retirement failed'
    )
    expect(stored()).toEqual(before)
    expectSameState(restoreJournal(database.db, sessionId)?.state)
  }
)

it('reports no completion when stopped and schedules another wake after a native failure', async () => {
  append([
    { ...base(1), kind: 'epoch', reason: 'session_created', providerHandle },
    item(2, 1),
    item(3, 2),
    item(4, 3)
  ])
  saveJournalState(database, state)
  const before = stored()
  let stopped = false
  // Stop during a real slice, before deletion starts.
  let clock = 0
  expect(
    await backfillJournalState({
      ...run(),
      stopped: () => stopped,
      now: () => (clock += 30),
      rest: async () => {
        stopped = true
      }
    })
  ).toBeNull()
  expect(stored()).toEqual(before)
  vi.useFakeTimers()
  database.db.exec(`CREATE TRIGGER fail_retirement BEFORE DELETE ON journal_rows
    BEGIN SELECT RAISE(ABORT, 'retirement failed'); END`)
  // Add another middle revision so both scheduled passes reach the native trigger.
  append([item(5, 4), item(6, 5)])
  saveJournalState(database, state)
  const onError = vi.fn()
  const task = startJournalStateBackfill(run(), onError)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(onError).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(6 * 60 * 60_000)
  expect(onError).toHaveBeenCalledTimes(2)
  task.stop()
  expect(vi.getTimerCount()).toBe(0)
  expect(stored().length).toBe(before.length + 2)
})
