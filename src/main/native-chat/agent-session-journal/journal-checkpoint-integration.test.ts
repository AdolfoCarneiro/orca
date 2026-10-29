import { once } from 'node:events'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Worker } from 'node:worker_threads'
import Database from '../../sqlite/sync-database'
import { JournalHostDatabase, journalDatabasePath } from './journal-host-database'
import { journalDatabaseHoldsAgentSessions } from './journal-database'
import { JOURNAL_DB_SCHEMA_VERSION } from './journal-database-schema'

let root: string
let host: JournalHostDatabase | undefined
afterEach(async () => {
  vi.restoreAllMocks()
  await host?.close()
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
})
async function open() {
  root = await mkdtemp(join(tmpdir(), 'orca-checkpoint-'))
  host = JournalHostDatabase.open(root)
  return host
}

it('moves checkpoints off the writer, retries a pinned idle tail, reclaims on reuse, and closes last', async () => {
  let checked: { log: number; checkpointed: number } | undefined
  let observed = false
  const post = Worker.prototype.postMessage
  vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (this: Worker, request) {
    if (!observed && request?.type === 'check') {
      observed = true
      this.on('message', (message) => {
        if (message.type === 'checked') {
          checked = message
        }
      })
    }
    return post.call(this, request)
  })
  const database = await open()
  const db = database.db
  expect(db.pragma('wal_autocheckpoint', { simple: true })).toBe(1000)
  await vi.waitFor(() => expect(db.pragma('wal_autocheckpoint', { simple: true })).toBe(0))
  expect(db.pragma('synchronous', { simple: true })).toBe(2)
  expect(db.pragma('checkpoint_fullfsync', { simple: true })).toBe(1)
  db.exec('CREATE TABLE checkpoint_probe (value BLOB)')
  db.pragma('journal_size_limit = 65536')
  database.transaction((writer) =>
    writer.exec('INSERT INTO checkpoint_probe VALUES (zeroblob(100))')
  )
  const reader = new Database(journalDatabasePath(root), { readonly: true })
  try {
    reader.exec('BEGIN; SELECT * FROM checkpoint_probe')
    for (let i = 0; i < 3; i++) {
      database.transaction((writer) =>
        writer.exec('INSERT INTO checkpoint_probe VALUES (zeroblob(200000))')
      )
    }
    const pinnedEnd = db.prepare('PRAGMA wal_checkpoint(NOOP)').get()!.log
    await vi.waitFor(() => {
      expect(checked?.log).toBe(pinnedEnd)
      expect(Number(checked?.log)).toBeGreaterThan(Number(checked?.checkpointed))
    })
    const pinned = db.prepare('PRAGMA wal_checkpoint(NOOP)').get()!
    expect(Number(pinned.log)).toBeGreaterThan(Number(pinned.checkpointed))
    reader.exec('COMMIT')
    // No new write: the worker must revisit the incomplete checkpoint and its small idle tail.
    await vi.waitFor(
      () => {
        const state = db.prepare('PRAGMA wal_checkpoint(NOOP)').get()!
        expect(state.log).toBe(state.checkpointed)
      },
      { timeout: 3000 }
    )
    database.transaction((writer) =>
      writer.exec('INSERT INTO checkpoint_probe VALUES (zeroblob(10))')
    )
    expect((await stat(`${journalDatabasePath(root)}-wal`)).size).toBeLessThanOrEqual(65536)
  } finally {
    reader.close()
  }
  await database.close()
  await expect(stat(`${journalDatabasePath(root)}-wal`)).rejects.toMatchObject({ code: 'ENOENT' })
  host = JournalHostDatabase.open(root)
  expect(host.db.prepare('SELECT count(*) AS n FROM checkpoint_probe').get()?.n).toBe(5)
})

it.each(['ordinary', 'streamed', 'autocommit'])(
  'does not reject a committed %s write when maintenance fails',
  async (mode) => {
    const database = await open()
    const db = database.db
    await vi.waitFor(() => expect(db.pragma('wal_autocheckpoint', { simple: true })).toBe(0))
    db.exec('CREATE TABLE checkpoint_probe (value INTEGER)')
    const post = vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(() => {
      throw new Error('post failed')
    })
    const pragma = db.pragma.bind(db)
    vi.spyOn(db, 'pragma').mockImplementation((sql, options) => {
      if (sql === 'wal_autocheckpoint = 1000') {
        throw new Error('fallback failed')
      }
      return pragma(sql, options)
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {
      throw new Error('log failed')
    })
    const insert = (writer: Database.Database) =>
      writer.exec('INSERT INTO checkpoint_probe VALUES (1)')
    expect(
      mode === 'autocommit'
        ? database.writeAutocommit(insert)
        : database.transaction(insert, mode === 'streamed')
    ).toBeUndefined()
    expect(post).toHaveBeenCalled()
    expect(db.prepare('SELECT count(*) AS n FROM checkpoint_probe').get()?.n).toBe(1)
    expect(db.pragma('synchronous', { simple: true })).toBe(2)
  }
)

it('never starts maintenance for probes or a newer read-only journal', async () => {
  const database = await open()
  database.db.pragma(`user_version = ${JOURNAL_DB_SCHEMA_VERSION + 1}`)
  await database.close()
  const worker = vi.spyOn(Worker.prototype, 'postMessage')
  journalDatabaseHoldsAgentSessions(journalDatabasePath(root))
  host = JournalHostDatabase.open(root)
  expect(host.readOnly).toBe(true)
  await host.close()
  expect(worker).not.toHaveBeenCalled()
})

it('configures the maintenance connection for full checkpoint flushing without changing journal mode', async () => {
  const { journalCheckpointWorkerSource } = await import('./journal-checkpoint-worker-source')
  const database = await open()
  const worker = new Worker(journalCheckpointWorkerSource, {
    eval: true,
    workerData: { filename: journalDatabasePath(root), sizeLimit: 65536 }
  })
  try {
    expect((await once(worker, 'message'))[0]).toEqual({
      type: 'ready',
      synchronous: 2,
      checkpoint_fullfsync: 1,
      journal_size_limit: 65536
    })
    const exited = once(worker, 'exit')
    worker.postMessage('close')
    await exited
    expect(database.db.pragma('journal_mode', { simple: true })).toBe('wal')
  } finally {
    await worker.terminate()
  }
})
