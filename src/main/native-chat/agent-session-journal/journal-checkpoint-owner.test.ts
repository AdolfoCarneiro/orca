import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import Database from '../../sqlite/sync-database'
import { JournalCheckpointOwner } from './journal-checkpoint-owner'

class CheckpointThread extends EventEmitter {
  postMessage = vi.fn((message: unknown) => {
    if (message === 'close') {
      this.emit('message', { type: 'closed' })
      queueMicrotask(() => this.emit('exit', 0))
    }
  })
  unref = vi.fn()
  terminate = vi.fn(async () => {
    this.emit('exit', 1)
    return 1
  })
}
const databases: Database.Database[] = []
const owners: JournalCheckpointOwner[] = []
function setup(timeoutMs = 1000) {
  const writer = new Database(':memory:')
  databases.push(writer)
  const worker = new CheckpointThread()
  const owner = new JournalCheckpointOwner(writer, ':memory:', { factory: () => worker, timeoutMs })
  owners.push(owner)
  return {
    writer,
    worker,
    owner,
    auto: () => writer.pragma('wal_autocheckpoint', { simple: true })
  }
}
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(owners.splice(0).map((owner) => owner.close()))
  for (const db of databases.splice(0)) db.close()
  vi.restoreAllMocks()
})

it('keeps startup maintenance, coalesces checks, and rechecks writes crossing an outstanding check', () => {
  const { worker, owner, auto } = setup()
  owner.afterCommit()
  expect(auto()).toBe(1000)
  expect(worker.postMessage).not.toHaveBeenCalled()
  worker.emit('message', { type: 'ready' })
  expect(auto()).toBe(0)
  expect(worker.postMessage).toHaveBeenCalledTimes(1)
  owner.afterCommit()
  owner.afterCommit()
  expect(worker.postMessage).toHaveBeenCalledTimes(1)
  worker.emit('message', { type: 'checked' })
  expect(worker.postMessage).toHaveBeenCalledTimes(1)
  worker.emit('message', { type: 'checked', id: 1 })
  expect(worker.postMessage).toHaveBeenCalledTimes(2)
  worker.emit('message', { type: 'checked', id: 2 })
  expect(worker.postMessage).toHaveBeenCalledTimes(2)
})

it.each(['init-error', 'error', 'exit', 'send', 'startup-timeout', 'check-timeout'])(
  'restores writer maintenance after %s and ignores late worker reports',
  async (failure) => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { worker, owner, auto } = setup(25)
    if (failure !== 'startup-timeout' && failure !== 'init-error') {
      worker.emit('message', { type: 'ready' })
      worker.emit('message', { type: 'checked', id: 1 })
    }
    if (failure === 'send') {
      worker.postMessage.mockImplementationOnce(() => {
        throw new Error('post failed')
      })
      owner.afterCommit()
    } else if (failure === 'error' || failure === 'init-error')
      worker.emit('error', new Error('checkpoint failed'))
    else if (failure === 'exit') worker.emit('exit', 1)
    else {
      if (failure === 'check-timeout') owner.afterCommit()
      await vi.advanceTimersByTimeAsync(26)
    }
    expect(auto()).toBe(1000)
    worker.emit('message', { type: 'ready' })
    worker.emit('message', { type: 'checked', id: 1 })
    expect(auto()).toBe(1000)
  }
)

it('awaits observed worker exit before restoring the writer, including forced close', async () => {
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const { writer, worker, owner, auto } = setup(25)
  worker.emit('message', { type: 'ready' })
  worker.postMessage.mockImplementation(() => undefined)
  worker.terminate.mockImplementation(async () => 1)
  let closed = false
  const closing = owner.close().then(() => {
    closed = true
  })
  worker.emit('message', { type: 'closed' })
  await vi.advanceTimersByTimeAsync(26)
  expect(worker.terminate).toHaveBeenCalledOnce()
  expect(closed).toBe(false)
  expect(auto()).toBe(0)
  worker.emit('exit', 1)
  await closing
  expect(auto()).toBe(1000)
  expect(writer.isTransaction).toBe(false)
})

it('keeps auto-checkpointing when worker construction or NOOP support is unavailable', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const { writer } = setup()
  const factory = vi.fn(() => {
    throw new Error('spawn failed')
  })
  const failed = new JournalCheckpointOwner(writer, ':memory:', { factory })
  owners.push(failed)
  expect(writer.pragma('wal_autocheckpoint', { simple: true })).toBe(1000)
  const prepare = writer.prepare.bind(writer)
  vi.spyOn(writer, 'prepare').mockImplementation((sql) =>
    prepare(sql.includes('sqlite_version') ? "SELECT '3.50.0' AS version" : sql)
  )
  const unsupportedFactory = vi.fn(() => new CheckpointThread())
  const unsupported = new JournalCheckpointOwner(writer, ':memory:', {
    factory: unsupportedFactory
  })
  owners.push(unsupported)
  expect(unsupportedFactory).not.toHaveBeenCalled()
})

it('hands maintenance back after failed retirement and keeps close retryable', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const { worker, owner, auto } = setup()
  worker.emit('message', { type: 'ready' })
  worker.postMessage.mockImplementationOnce(() => {
    throw new Error('close send failed')
  })
  worker.terminate.mockRejectedValueOnce(new Error('retirement failed'))
  await expect(owner.close()).rejects.toThrow('retirement failed')
  expect(auto()).toBe(1000)
  await owner.close()
})
