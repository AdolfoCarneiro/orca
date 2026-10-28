import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import * as spawn from '../../foreign-sqlite-readers/foreign-sqlite-reader-spawn'
import Database from '../../sqlite/sync-database'
import type { SqliteBindings } from '../../sqlite/sqlite-statement'
import { replayJournal } from './journal-open'
import { JOURNAL_TEXT_PRUNE_BYTES } from './journal-text-proof-cache'
import {
  closeTextJournals,
  textBody as body,
  textIdentity as identity,
  textIdentityOf,
  textJournals,
  textOptions as options,
  textRig
} from './journal-text-test-support'

const root = mkdtempSync(join(tmpdir(), 'orca-text-validator-'))
const entry = join(root, 'foreign-sqlite-reader-entry.cjs')
const workers: Worker[] = []
let workerBytes = 0
let workerReads = 0
let onValidated: (() => void) | undefined

beforeAll(async () => {
  await build({
    entryPoints: [
      resolve(__dirname, '../../foreign-sqlite-readers/foreign-sqlite-reader-entry.ts')
    ],
    outfile: entry,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
    logLevel: 'error'
  })
})
beforeEach(() => {
  workerBytes = workerReads = 0
  onValidated = undefined
  vi.spyOn(spawn, 'createForeignSqliteReaderWorker').mockImplementation(() => {
    const worker = new Worker(entry)
    workers.push(worker)
    worker.on('message', (response: unknown) => {
      if (
        response &&
        typeof response === 'object' &&
        'bytes' in response &&
        typeof response.bytes === 'number'
      ) {
        workerBytes += response.bytes
        workerReads++
        onValidated?.()
      }
    })
    return worker
  })
})
afterEach(async () => {
  onValidated = undefined
  vi.restoreAllMocks()
  await closeTextJournals()
})
afterAll(async () => {
  await Promise.all(workers.map((worker) => worker.terminate()))
  rmSync(root, { recursive: true, force: true })
})

function rows(db: Database.Database): number {
  return Number(db.prepare('SELECT count(*) AS n FROM journal_rows').get()?.n)
}

async function drain(r: Awaited<ReturnType<typeof textRig>>, count: number) {
  await vi.waitFor(() => expect(rows(r.database.db)).toBe(count), { timeout: 10_000, interval: 5 })
}

// Count actual SQLite payload reads, not just parses; worker replies count its real full-row read too.
function measureReads() {
  const prepare = Database.prototype.prepare
  let bytes = 0
  let unitBytes = 0
  let maxUnitBytes = 0
  const exec = Database.prototype.exec
  vi.spyOn(Database.prototype, 'exec').mockImplementation(function (this: Database.Database, sql) {
    if (sql === 'BEGIN IMMEDIATE') {
      unitBytes = 0
    }
    const result = exec.call(this, sql)
    if (sql === 'COMMIT') {
      maxUnitBytes = Math.max(maxUnitBytes, unitBytes)
    }
    return result
  })
  vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (
    this: Database.Database,
    sql
  ) {
    const statement = prepare.call(this, sql)
    if (!sql.startsWith('SELECT row_json FROM journal_rows')) {
      return statement
    }
    return {
      all: (...args: SqliteBindings) => statement.all(...args),
      get: (...args: SqliteBindings) => {
        const row = statement.get(...args)
        if (typeof row?.row_json === 'string') {
          const size = Buffer.byteLength(row.row_json)
          bytes += size
          unitBytes += size
        }
        return row
      },
      run: (...args: SqliteBindings) => statement.run(...args),
      iterate: (...args: SqliteBindings) => statement.iterate(...args),
      setReadBigInts: (enabled) => statement.setReadBigInts(enabled)
    }
  })
  return { values: () => ({ bytes, maxUnitBytes }) }
}

it('cleans the real N/10N probe with linear decoded AND fetched bytes', async () => {
  const results: number[] = []
  for (const n of [600, 6000]) {
    const r = await textRig()
    const suffix = 'X'.repeat(1000)
    for (let k = 0; k <= n; k++) {
      await r.journal.appendItem(identity, body(''), {
        ...options,
        streamText: {
          operation: k === 0 ? 'start' : 'append',
          field: 0,
          baseLength: k * 1000,
          suffix
        }
      })
    }
    const read = measureReads()
    const parse = JSON.parse
    let decodedBytes = 0
    vi.spyOn(JSON, 'parse').mockImplementation((json, reviver) => {
      if (typeof json === 'string' && json.includes('X'.repeat(100))) {
        decodedBytes += Buffer.byteLength(json)
      }
      return parse(json, reviver)
    })
    workerBytes = workerReads = 0
    await r.journal.appendItem(identity, body(suffix.repeat(n + 1)), options)
    await drain(r, 3)
    const fetched = read.values()
    const total = decodedBytes + workerBytes
    results.push(total)
    expect(fetched.maxUnitBytes).toBeLessThanOrEqual(JOURNAL_TEXT_PRUNE_BYTES)
    expect(workerReads).toBe(1)
    expect(fetched.bytes + workerBytes).toBeLessThan(3 * (n + 1) * 1500)
    console.info('journal byte contract', {
      n,
      decodedBytes,
      workerBytes,
      workerReads,
      ...fetched,
      total
    })
    vi.restoreAllMocks()
    expect(replayJournal(r.database.db, 'chat')?.damage).toBeNull()
    expect(r.rows().some((row) => row.kind === 'text-delta')).toBe(false)
    await closeTextJournals()
  }
  expect(results[1]).toBeLessThan(11 * results[0])
})

it('reads a 4MB boundary once across the real 30-small-items probe and cache eviction', async () => {
  const r = await textRig()
  await r.journal.appendItem(identity, body(''), {
    ...options,
    streamText: {
      operation: 'start',
      field: 0,
      baseLength: 0,
      suffix: `FIRST_LARGE_ANCHOR${'Z'.repeat(4_000_000)}`
    }
  })
  const read = measureReads()
  for (let k = 0; k < 330; k++) {
    const id = textIdentityOf(`small-${k}`)
    for (let n = 0; n < 2; n++) {
      await r.journal.appendItem(id, body(''), {
        ...options,
        streamText: {
          operation: n === 0 ? 'start' : 'append',
          field: 0,
          baseLength: n,
          suffix: n === 0 ? 'a' : 'b'
        }
      })
    }
    await r.journal.appendItem(id, body('ab'), options)
    await drain(r, 2 + 2 * (k + 1))
    if (k === 29) {
      console.info('30-item boundary contract', { workerBytes, workerReads, ...read.values() })
    }
  }
  expect(workerReads).toBe(1)
  expect(workerBytes).toBeGreaterThan(4_000_000)
  expect(read.values().maxUnitBytes).toBeLessThanOrEqual(JOURNAL_TEXT_PRUNE_BYTES)
  expect(read.values().bytes).toBeLessThan(330 * 1500)
  console.info('330-item boundary contract', { workerBytes, workerReads, ...read.values() })
})

it.each([
  'missing',
  'nested',
  'external',
  'future',
  'envelope',
  'revision',
  'receipt',
  'replace',
  'rollback'
])('rejects %s changes between worker validation and deletion', async (corruption) => {
  const r = await textRig()
  await r.append(identity, 0)
  for (let k = 1; k <= 300; k++) {
    await r.append(identity, k)
  }
  const last = r.journal.cursor().sequence + 1
  let faulted = false
  const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  onValidated = () => {
    onValidated = undefined
    faulted = true
    const external =
      corruption === 'external' ? new Database(join(r.root, 'agent-session-journal.db')) : null
    const db = external ?? r.database.db
    if (corruption === 'rollback') {
      const exec = db.exec.bind(db)
      vi.spyOn(db, 'exec').mockImplementation((sql) => {
        if (sql === 'COMMIT' && rows(db) < 303) {
          throw new Error('injected commit failure')
        }
        return exec(sql)
      })
    } else if (corruption === 'missing') {
      db.prepare('DELETE FROM journal_rows WHERE seq = ?').run(last)
    } else {
      const json = db.prepare('SELECT row_json FROM journal_rows WHERE seq = ?').get(last)?.row_json
      if (typeof json !== 'string') {
        throw new Error('missing test witness')
      }
      const changed =
        corruption === 'future'
          ? json.replace(/"v":\d+/, '"v":6')
          : corruption === 'envelope'
            ? json.replace(`"seq":${last}`, '"seq":1')
            : corruption === 'revision'
              ? json.replace('"revision":302', '"revision":1')
              : json.replace('"blocks":', '"skills":[{"name":17,"path":null}],"blocks":')
      expect(changed).not.toBe(json)
      if (corruption === 'receipt') {
        // Exercise the same connection inside a real receipt after its row INSERT.
        void r.journal.appendQueueResume(7, {
          write: (receiptDb) => {
            receiptDb
              .prepare('UPDATE journal_rows SET row_json = ? WHERE seq = ?')
              .run(changed, last)
          },
          committed: () => undefined
        })
      } else if (corruption === 'replace') {
        db.prepare(
          'INSERT OR REPLACE INTO journal_rows SELECT session_id, epoch, seq, ts, ? FROM journal_rows WHERE seq = ?'
        ).run(changed, last)
      } else {
        db.prepare('UPDATE journal_rows SET row_json = ? WHERE seq = ?').run(changed, last)
      }
    }
    external?.close()
  }
  await r.journal.appendItem(identity, body('large-whole-tag'.repeat(10_000)), options)
  await vi.waitFor(() => expect(warned).toHaveBeenCalled(), { timeout: 10_000, interval: 5 })
  expect(faulted).toBe(true)
  expect(rows(r.database.db)).toBe(
    corruption === 'missing' ? 302 : corruption === 'receipt' ? 304 : 303
  )
  if (corruption === 'rollback') {
    vi.mocked(r.database.db.exec).mockRestore()
    await r.journal.appendItem(identity, body('repaired'), options)
    await drain(r, 4)
    expect(replayJournal(r.database.db, 'chat')?.damage).toBeNull()
  }
})

it('revalidates cold/reopened rows and retires a large suffix without retaining it', async () => {
  const r = await textRig()
  await r.append(identity, 0)
  await r.journal.appendItem(identity, body(''), {
    ...options,
    streamText: { operation: 'append', field: 0, baseLength: 1, suffix: 'L'.repeat(300_000) }
  })
  await r.journal.appendItem(identity, body('whole'), { ...options, recovered: true })
  await r.journal.close()
  const reopened = await textJournals.open(r.settings)
  await reopened.appendItem(identity, body('whole'), options)
  await drain(r, 4)
  expect(workerReads).toBeGreaterThanOrEqual(1)
  expect(replayJournal(r.database.db, 'chat')?.damage).toBeNull()
  expect(r.rows().some((row) => row.kind === 'text-delta')).toBe(false)
  expect(
    Number(r.database.db.prepare('SELECT count(*) AS n FROM temp.journal_text_proofs').get()?.n)
  ).toBeLessThanOrEqual(256)
})

it('rolls back deletion when a DELETE trigger changes a previously validated support', async () => {
  const r = await textRig()
  await r.append(identity, 0)
  await r.append(identity, 1)
  r.database.db.exec(`CREATE TEMP TRIGGER change_support AFTER DELETE ON journal_rows BEGIN
    UPDATE journal_rows SET row_json = '{}' WHERE seq = 2;
  END`)
  const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  await r.journal.appendItem(identity, body('aa'), options)
  expect(warned).toHaveBeenCalled()
  expect(rows(r.database.db)).toBe(4)
  expect(replayJournal(r.database.db, 'chat')?.damage).toBeNull()
  expect(r.rows().some((row) => row.kind === 'text-delta')).toBe(true)
})

it('revalidates a cold boundary after reopen and external writes, but reuses it across local metadata writes', async () => {
  const r = await textRig()
  await r.journal.appendItem(identity, body(''), {
    ...options,
    streamText: { operation: 'start', field: 0, baseLength: 0, suffix: 'B'.repeat(300_000) }
  })
  let journal = r.journal
  for (let k = 0; k < 5; k++) {
    if (k === 1) {
      await journal.close()
      journal = await textJournals.open(r.settings)
    }
    if (k === 2) {
      const external = new Database(join(r.root, 'agent-session-journal.db'))
      external.prepare('UPDATE journal_sessions SET workspace_id = ?').run('folder-other')
      external.close()
    }
    if (k === 3) {
      r.database.db.exec('CREATE TABLE unrelated_metadata (value TEXT)')
    }
    if (k === 4) {
      r.database.db.prepare('UPDATE journal_sessions SET workspace_id = ?').run('folder')
    }
    const id = textIdentityOf(`cold-${k}`)
    for (let n = 0; n < 2; n++) {
      await journal.appendItem(id, body(''), {
        ...options,
        streamText: {
          operation: n === 0 ? 'start' : 'append',
          field: 0,
          baseLength: n,
          suffix: 'a'
        }
      })
    }
    await journal.appendItem(id, body('aa'), options)
    await drain(r, 2 + 2 * (k + 1))
    expect(workerReads).toBe(Math.min(k + 1, 4))
    expect(replayJournal(r.database.db, 'chat')?.damage).toBeNull()
  }
})

it('retries a failed worker transport without falling back to large synchronous reads', async () => {
  const r = await textRig()
  await r.append(identity, 0)
  await r.append(identity, 1)
  const read = measureReads()
  const postMessage = Worker.prototype.postMessage
  let failures = 0
  vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (this: Worker, ...args) {
    if (failures === 0) {
      failures++
      throw new Error('injected worker transport failure')
    }
    return postMessage.apply(this, args)
  })
  const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  await r.journal.appendItem(identity, body('retry'.repeat(100_000)), options)
  await drain(r, 3)
  expect(failures).toBe(1)
  expect(warned).toHaveBeenCalled()
  expect(workerReads).toBe(1)
  expect(read.values().maxUnitBytes).toBeLessThanOrEqual(JOURNAL_TEXT_PRUNE_BYTES)
  expect(replayJournal(r.database.db, 'chat')?.damage).toBeNull()
})

it.each(['settlement', 'mutation', 'nested-mutation'])(
  'fully rechecks a large lifecycle %s after preparation',
  async (corruption) => {
    const r = await textRig()
    await r.append(identity, 0)
    await r.append(identity, 1)
    const seq = r.journal.cursor().sequence + 1
    onValidated = () => {
      onValidated = undefined
      const json = r.database.db
        .prepare('SELECT row_json FROM journal_rows WHERE seq = ?')
        .get(seq)?.row_json
      if (typeof json !== 'string') {
        throw new Error('missing lifecycle witness')
      }
      const changed =
        corruption === 'settlement'
          ? json.replace('"settlementId":"settled"', '"settlementId":"changed"')
          : corruption === 'mutation'
            ? json.replace('"itemId":"claude:provider:reply"', '"itemId":"claude:provider:other"')
            : json.replace('"blocks":', '"skills":[{"name":17,"path":null}],"blocks":')
      expect(changed).not.toBe(json)
      r.database.db.prepare('UPDATE journal_rows SET row_json = ? WHERE seq = ?').run(changed, seq)
    }
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await r.journal.appendLifecycleBatch({
      settlementId: 'settled',
      fence: 7,
      mutations: [
        { kind: 'item', identity, body: body('L'.repeat(200_000)), turnScope: options.turnScope }
      ]
    })
    await vi.waitFor(() => expect(warned).toHaveBeenCalled(), { timeout: 10_000, interval: 5 })
    expect(rows(r.database.db)).toBe(4)
  }
)

it.each(['field', 'revision'])(
  'rechecks a large target %s changed after worker preparation',
  async (field) => {
    const r = await textRig()
    await r.append(identity, 0)
    await r.journal.appendItem(identity, body(''), {
      ...options,
      streamText: { operation: 'append', field: 0, baseLength: 1, suffix: 'T'.repeat(300_000) }
    })
    onValidated = () => {
      onValidated = undefined
      const json = r.database.db
        .prepare('SELECT row_json FROM journal_rows WHERE seq = 3')
        .get()?.row_json
      if (typeof json !== 'string') {
        throw new Error('missing large target')
      }
      const changed =
        field === 'field'
          ? json.replace('"field":0', '"field":1')
          : json.replace('"revision":2', '"revision":30')
      expect(changed).not.toBe(json)
      r.database.db.prepare('UPDATE journal_rows SET row_json = ? WHERE seq = 3').run(changed)
    }
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await r.journal.appendItem(identity, body('whole'), options)
    await vi.waitFor(() => expect(warned).toHaveBeenCalled(), { timeout: 10_000, interval: 5 })
    expect(rows(r.database.db)).toBe(4)
  }
)
