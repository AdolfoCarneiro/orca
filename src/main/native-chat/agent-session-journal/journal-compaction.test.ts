import Database from '../../sqlite/sync-database'
import * as rowTable from './journal-row-table'
import * as rowSchema from './journal-row-schema'
import * as journalOpen from './journal-open'
import { encodeJournalState } from './journal-state-codec'
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
  expect(await compact()).toBe(4)
  expect(stored().map((row) => row.seq)).toEqual([1, 2, 5, 6, 9, 10])
  expectSameState(restoreJournal(database.db, sessionId)?.state)
  // First/latest sibling anchors and the stale latest reply touch pin whole batches.
  const exceptions = stored()
    .filter((row) => [5, 6, 9].includes(row.seq))
    .map((row) => [row.seq, Buffer.byteLength(row.rowJson)])
  expect(exceptions).toEqual([
    [5, 470],
    [6, 471],
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

it.each(['body', 'role', 'owner'] as const)(
  'refuses the first retirement when complete-prefix durable %s differs, then validates a real retirement',
  async (damage) => {
    append([
      { ...base(1), kind: 'epoch', reason: 'session_created', providerHandle },
      item(2, 1),
      { ...item(3, 2), executionOwner: 7, agentId: 'child', producerKind: 'agent' },
      item(4, 3),
      item(5, 1)
    ])
    const healthy = encodeJournalState(state)
    if (damage === 'owner') {
      state.itemExecutionOwners.delete('reply')
    } else {
      const current = state.items.get('reply')!
      state.items.set('reply', {
        ...current,
        body: damage === 'body' ? text('corrupt body') : { ...text('revision 3'), role: 'user' }
      })
    }
    expect(saveJournalState(database, state)).toBe(true)
    const before = stored()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await compact()).toBe(0)
    expect(stored()).toEqual(before)
    expect(warn).toHaveBeenCalled()
    // Restore the independently folded checkpoint; no raw row was edited or manufactured as retired.
    state = replayJournal(database.db, sessionId)!.state
    expect(encodeJournalState(state)).toEqual(healthy)
    expect(saveJournalState(database, state, true)).toBe(true)
    const fold = vi.spyOn(journalOpen, 'startJournalRowFold')
    expect(await compact()).toBe(2)
    expect(fold).toHaveBeenCalledTimes(1)
    expect(stored().map((row) => row.seq)).toEqual([1, 2, 5])
    expectSameState(restoreJournal(database.db, sessionId)?.state)
    append([item(6, 4), item(7, 5), item(8, 1)])
    saveJournalState(database, state)
    fold.mockClear()
    expect(await compact()).toBe(3)
    expect(fold).not.toHaveBeenCalled()
    expect(stored().map((row) => row.seq)).toEqual([1, 2, 8])
    expectSameState(restoreJournal(database.db, sessionId)?.state)
  }
)

it('does no independent fold without candidates and compares JSON objects semantically', async () => {
  append([{ ...base(1), kind: 'epoch', reason: 'session_created', providerHandle }, item(2, 1)])
  saveJournalState(database, state)
  const fold = vi.spyOn(journalOpen, 'startJournalRowFold')
  expect(await compact()).toBe(0)
  expect(fold).not.toHaveBeenCalled()
  append([item(3, 2), item(4, 3)])
  saveJournalState(database, state)
  // Object key ordering is not durable state; map/item order still is.
  const json = database.db.prepare('SELECT state_json FROM journal_state').get()?.state_json
  if (typeof json !== 'string') throw new Error('missing checkpoint')
  database.db
    .prepare('UPDATE journal_state SET state_json = ?')
    .run(JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(json)).reverse()), null, 2))
  expect(await compact()).toBe(1)
})

it.each(['missing epoch', 'wrong epoch', 'invalid sequence'])(
  'does not treat %s damage as an earlier retirement',
  async (damage) => {
    append([
      { ...base(1), kind: 'epoch', reason: 'session_created', providerHandle },
      item(2, 1),
      item(3, 2),
      item(4, 3)
    ])
    saveJournalState(database, state)
    if (damage === 'missing epoch') database.db.exec('DELETE FROM journal_rows WHERE seq = 1')
    else if (damage === 'wrong epoch')
      database.db
        .prepare('UPDATE journal_rows SET row_json = ? WHERE seq = 3')
        .run(JSON.stringify({ ...item(3, 2), epoch: 'foreign' }))
    else
      database.db
        .prepare('INSERT INTO journal_rows VALUES (?, ?, ?, ?, ?)')
        .run(sessionId, epoch, 0, 1000, JSON.stringify(item(0, 1)))
    const before = stored()
    expect(await compact()).toBe(0)
    expect(stored()).toEqual(before)
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
  database.db.exec('DROP TRIGGER fail_retirement')
  await vi.advanceTimersByTimeAsync(6 * 60 * 60_000)
  expect(onError).toHaveBeenCalledTimes(2)
  expect(stored().map((row) => row.seq)).toEqual([1, 2, 6])
  expectSameState(restoreJournal(database.db, sessionId)?.state)
  task.stop()
  expect(vi.getTimerCount()).toBe(0)
})

it.each([10, 100])(
  'bounds real maintenance and anchors for %i duplicate/imported batches',
  async (count) => {
    database.db.pragma('auto_vacuum = 0')
    database.db.exec('VACUUM')
    append([
      { ...base(1), kind: 'epoch', reason: 'legacy_import', providerHandle },
      item(2, 1),
      item(3, 1, 'removed')
    ])
    const rows: JournalRow[] = []
    const batch = (
      settlementId: string,
      mutations: Extract<JournalRow, { kind: 'lifecycle-batch' }>['mutations']
    ) => {
      rows.push({ ...base(4 + rows.length), kind: 'lifecycle-batch', settlementId, mutations })
    }
    const current = { kind: 'item', itemId: 'reply', revision: 2, body: text('P') } as const
    for (let index = 0; index < count; index++) {
      batch('repeated', [current])
      batch(`paired-${index}`, [current])
      batch(`paired-${index}`, [
        { ...current, revision: 99, body: { ...text('ignored'), role: 'user' } }
      ])
      rows.push({ ...item(4 + rows.length, 2), body: text('P') })
      batch(`remove-${index}`, [{ kind: 'tombstone', itemId: 'removed', revision: 2 }])
    }
    const shared = 4 + rows.length
    batch('sibling', [current, { ...current, itemId: 'sibling', revision: 1 }])
    rows.push(item(4 + rows.length, 1), item(5 + rows.length, 1, 'removed'))
    const stop = 4 + rows.length
    rows.push({
      ...base(stop),
      kind: 'tombstone',
      itemId: 'stop',
      revision: 1,
      stopEvent: { reason: 'user-stop', at: 1000 + stop }
    })
    append(rows)
    saveJournalState(database, state)
    const beforeBytes = stored().reduce((sum, row) => sum + Buffer.byteLength(row.rowJson), 0)
    const read = vi.spyOn(rowTable, 'readJournalRowsAfter')
    const parse = vi.spyOn(rowSchema, 'parseJournalRow')
    const transaction = vi.spyOn(database, 'transaction')
    const physicalReads: number[] = []
    let deleteCalls = 0
    const prepare = Database.prototype.prepare
    const observed = new WeakSet<object>()
    vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (this: Database, sql) {
      const statement = prepare.call(this, sql)
      if (!observed.has(statement)) {
        observed.add(statement)
        if (sql.startsWith('SELECT seq, ts, row_json FROM journal_rows')) {
          const all = statement.all.bind(statement)
          vi.spyOn(statement, 'all').mockImplementation((...args) => {
            const rows = all(...args)
            physicalReads.push(rows.length)
            return rows
          })
        } else if (sql.startsWith('DELETE FROM journal_rows')) {
          const remove = statement.run.bind(statement)
          vi.spyOn(statement, 'run').mockImplementation((...args) => {
            deleteCalls++
            return remove(...args)
          })
        }
      }
      return statement
    })
    const set = Map.prototype.set
    let summaries = 0
    const summaryKeys = new Set<string>()
    const summary = vi.spyOn(Map.prototype, 'set').mockImplementation(function (
      this: Map<unknown, unknown>,
      key,
      value
    ) {
      if (
        typeof key === 'string' &&
        value &&
        typeof value === 'object' &&
        'first' in value &&
        'last' in value
      ) {
        summaries++
        summaryKeys.add(key)
      }
      return set.call(this, key, value)
    })
    expect(await backfillJournalState(run())).toEqual({ deleted: 5 * count })
    summary.mockRestore()
    const parsed = parse.mock.results.flatMap((result) =>
      result.type === 'return' && result.value.ok ? [result.value.row] : []
    )
    const contributions = parsed.reduce(
      (sum, row) =>
        sum + (row.kind === 'lifecycle-batch' ? row.mutations.length : row.kind === 'item' ? 1 : 0),
      0
    )
    const retained = [1, 2, 3, shared, shared + 1, shared + 2, stop]
    expect(summaries).toBe(5 * count + 6)
    expect(summaryKeys.size).toBe(3)
    expect(deleteCalls).toBe(5 * count)
    expect(physicalReads.reduce((sum, size) => sum + size, 0)).toBe(3 * (5 * count + 7))
    expect(physicalReads.every((size) => size <= 32)).toBe(true)
    expect(parse).toHaveBeenCalledTimes(3 * (5 * count + 7))
    expect(contributions).toBe(3 * (5 * count + 6))
    expect(
      read.mock.results.every((result) => result.type === 'return' && result.value.length <= 32)
    ).toBe(true)
    expect(read.mock.calls.length).toBeLessThanOrEqual(2 * Math.ceil((5 * count + 7) / 32))
    const chunks = transaction.mock.calls.filter((call) => call[1] === true).length
    expect(chunks).toBeGreaterThanOrEqual(Math.ceil((5 * count) / 8))
    expect(chunks).toBeLessThanOrEqual(Math.ceil((5 * count) / 8) + Math.ceil((5 * count + 7) / 32))
    const residual = stored()
    expect(residual.map((row) => row.seq)).toEqual(retained)
    const bytes = residual.reduce((sum, row) => sum + Buffer.byteLength(row.rowJson), 0)
    expect(bytes).toBeLessThan(beforeBytes)
    expect(
      residual
        .filter((row) => JSON.parse(row.rowJson).kind === 'lifecycle-batch')
        .map((row) => row.seq)
    ).toEqual([shared])
    expect(residual.filter((row) => row.rowJson.includes('ignored'))).toEqual([])
    expect(
      residual.filter((row) => ['item', 'lifecycle-batch'].includes(JSON.parse(row.rowJson).kind))
    ).toHaveLength(5)
    expect(5).toBeLessThanOrEqual(2 * summaryKeys.size)
    expect(
      residual.reduce((copies, row) => {
        const parsed = rowSchema.parseJournalRow(row.rowJson)
        if (!parsed.ok) throw new Error('unreadable residual')
        const mutations =
          parsed.row.kind === 'lifecycle-batch'
            ? parsed.row.mutations
            : parsed.row.kind === 'item'
              ? [parsed.row]
              : []
        return copies + mutations.filter((mutation) => mutation.itemId === 'reply').length
      }, 0)
    ).toBe(3)
    expectSameState(restoreJournal(database.db, sessionId)?.state)
    closeTestJournalHostDatabases()
    database = openTestJournalHostDatabase(root)
    read.mockClear()
    parse.mockClear()
    physicalReads.length = 0
    const deletesBefore = deleteCalls
    expect(await backfillJournalState(run())).toEqual({ deleted: 0 })
    expect(parse).toHaveBeenCalledTimes(2 * retained.length)
    expect(read).toHaveBeenCalledTimes(1)
    expect(physicalReads).toEqual([retained.length, retained.length])
    expect(deleteCalls).toBe(deletesBefore)
    expect(stored()).toEqual(residual)
    expect(stored().reduce((sum, row) => sum + Buffer.byteLength(row.rowJson), 0)).toBe(bytes)
  }
)

it.each(['append', 'reopen', 'epoch'] as const)(
  'keeps its captured prefix across a paced %s',
  async (change) => {
    append([
      { ...base(1), kind: 'epoch', reason: 'session_created', providerHandle },
      item(2, 1),
      item(3, 2),
      item(4, 3)
    ])
    saveJournalState(database, state)
    const before = stored()
    let wakes = 0
    const outcome = await compactJournalSession(database, sessionId, epoch, async () => {
      expect(database.db.isTransaction).toBe(false)
      if (++wakes === 4) {
        if (change === 'append') {
          append([item(5, 4), item(6, 5)])
          saveJournalState(database, state)
        } else if (change === 'reopen') {
          closeTestJournalHostDatabases()
          database = openTestJournalHostDatabase(root)
        } else publishTestJournalEpoch(database.db, sessionId, 'new-epoch')
      }
      return database
    })
    if (change === 'append') {
      expect(outcome).toBe(1)
      expect(stored().map((row) => row.seq)).toEqual([1, 2, 4, 5, 6])
      expectSameState(restoreJournal(database.db, sessionId)?.state)
    } else {
      expect(outcome).toBeNull()
      if (change === 'reopen') expect(stored()).toEqual(before)
      else
        expect(
          database.db.prepare('SELECT COUNT(*) AS n FROM journal_rows WHERE epoch = ?').get(epoch)
            ?.n
        ).toBe(before.length)
    }
  }
)

it('keeps uncheckpointed tails after a failed FULL publication and retires them after a real later save', async () => {
  append([{ ...base(1), kind: 'epoch', reason: 'session_created', providerHandle }, item(2, 1)])
  saveJournalState(database, state)
  append([item(3, 2), item(4, 3), item(5, 4)])
  const before = stored()
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  database.db.exec(
    "CREATE TRIGGER fail_checkpoint BEFORE INSERT ON journal_state BEGIN SELECT RAISE(ABORT, 'save failed'); END"
  )
  expect(await backfillJournalState(run())).toBeNull()
  expect(warn).toHaveBeenCalled()
  expect(stored()).toEqual(before)
  expect(readJournalSavedState(database.db, sessionId, epoch)?.lastSequence).toBe(2)
  database.db.exec('DROP TRIGGER fail_checkpoint')
  expect(await backfillJournalState(run())).toEqual({ deleted: 2 })
  expectSameState(restoreJournal(database.db, sessionId)?.state)
})

it('leaves an active FULL host transaction alone and retries a stranded native rollback before reuse', async () => {
  append([
    { ...base(1), kind: 'epoch', reason: 'session_created', providerHandle },
    item(2, 1),
    item(3, 2),
    item(4, 3),
    item(5, 4)
  ])
  saveJournalState(database, state)
  const before = stored()
  const connection = database.db
  connection.exec('BEGIN IMMEDIATE')
  await expect(compact()).rejects.toThrow(/transaction|Safety level/i)
  expect(connection.isTransaction).toBe(true)
  connection.exec('ROLLBACK')
  expect(stored()).toEqual(before)
  connection.exec(`CREATE TABLE retirement_parent (id INTEGER PRIMARY KEY);
    CREATE TABLE retirement_child (parent_id INTEGER REFERENCES retirement_parent(id) DEFERRABLE INITIALLY DEFERRED);
    CREATE TRIGGER fail_retirement BEFORE DELETE ON journal_rows WHEN old.seq = 4
      BEGIN INSERT INTO retirement_child VALUES (1); END`)
  const exec = connection.exec.bind(connection)
  let rollbackFails = true
  const intercepted = vi.spyOn(connection, 'exec').mockImplementation((sql) => {
    if (sql === 'ROLLBACK' && rollbackFails) throw new Error('native rollback unavailable')
    return exec(sql)
  })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  await expect(compact()).rejects.toThrow(/FOREIGN KEY/i)
  expect(connection.isTransaction).toBe(true)
  await expect(compact()).rejects.toThrow()
  rollbackFails = false
  // The host getter must first undo the whole failed chunk and restore FULL.
  expect(stored()).toEqual(before)
  expect(Number(connection.pragma('synchronous', { simple: true }))).toBe(2)
  intercepted.mockRestore()
  connection.exec('DROP TRIGGER fail_retirement')
  expect(await compact()).toBe(2)
  expectSameState(restoreJournal(database.db, sessionId)?.state)
})

it('cancels between bounded chunks without a completion latch, then finishes on the normal next pass', async () => {
  append([
    { ...base(1), kind: 'epoch', reason: 'session_created', providerHandle },
    ...Array.from({ length: 24 }, (_, index) => item(index + 2, index + 1))
  ])
  saveJournalState(database, state)
  const total = stored().length
  expect(
    await compactJournalSession(database, sessionId, epoch, async () => {
      expect(database.db.isTransaction).toBe(false)
      return stored().length < total ? null : database
    })
  ).toBeNull()
  expect(total - stored().length).toBe(8)
  expectSameState(restoreJournal(database.db, sessionId)?.state)
  expect(await compact()).toBe(14)
  expect(stored().map((row) => row.seq)).toEqual([1, 2, 25])
})

it.each(['blob JSON', 'text timestamp'])(
  'rejects a physically present unreadable SQL row rather than treating it as a retired hole: %s',
  async (damage) => {
    append([
      { ...base(1), kind: 'epoch', reason: 'session_created', providerHandle },
      item(2, 1),
      item(3, 2),
      item(4, 3),
      item(5, 4),
      item(6, 5)
    ])
    saveJournalState(database, state)
    database.db.exec(
      damage === 'blob JSON'
        ? 'UPDATE journal_rows SET row_json = CAST(row_json AS BLOB) WHERE seq = 4'
        : "UPDATE journal_rows SET ts = 'not-a-timestamp' WHERE seq = 4"
    )
    const physical = () =>
      database.db.prepare('SELECT seq, ts, row_json FROM journal_rows ORDER BY seq').all()
    const before = physical()
    expect(await compact()).toBe(0)
    expect(physical()).toEqual(before)
  }
)
