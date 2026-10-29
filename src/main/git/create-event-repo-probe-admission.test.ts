import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { probeCreateEventRepoFacts } from './create-event-repo-probe'

const fs = vi.hoisted(() => ({
  readFile: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn(),
  open: vi.fn()
}))
vi.mock('node:fs/promises', () => fs)

const repo = path.join(path.sep, 'repo')
const gitDir = path.join(repo, '.git')
const registry = path.join(gitDir, 'worktrees')
const config = path.join(gitDir, 'config')
const read = vi.fn()
const close = vi.fn()

function directories(count: number): { name: string; isDirectory: () => boolean }[] {
  return Array.from({ length: count }, (_, index) => ({
    name: String(index),
    isDirectory: () => true
  }))
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  fs.stat.mockImplementation(async (file: string) => ({
    isDirectory: () => file === gitDir,
    isFile: () => false
  }))
  fs.readFile.mockImplementation(async (file: string) =>
    file === config ? '[core]\n bare = false\n' : ''
  )
  fs.readdir.mockResolvedValue([])
  read.mockImplementation(async (buffer: Buffer) => {
    buffer.write('DIRC')
    buffer.writeUInt32BE(2, 4)
    buffer.writeUInt32BE(11, 8)
    return { bytesRead: 12 }
  })
  close.mockResolvedValue(undefined)
  fs.open.mockResolvedValue({ read, close })
})

afterEach(() => {
  expect(vi.getTimerCount()).toBe(0)
  vi.useRealTimers()
})

describe('workspace-created repository probe admission', () => {
  it('does not start lock reads after a registry listing outlives its count deadline', async () => {
    const listing = Promise.withResolvers<ReturnType<typeof directories>>()
    const started = Promise.withResolvers<void>()
    fs.readdir.mockImplementation(async (file: string) => {
      if (file === registry) {
        started.resolve()
        return listing.promise
      }
      return []
    })
    const pending = probeCreateEventRepoFacts(repo)
    await started.promise
    await vi.advanceTimersByTimeAsync(1_500)
    expect(await pending).toEqual({ postCheckoutHook: 'absent', indexEntryCount: 11 })

    const readsAtReturn = fs.readFile.mock.calls.length
    listing.resolve(directories(50))
    await vi.advanceTimersByTimeAsync(0)
    expect(fs.readFile).toHaveBeenCalledTimes(readsAtReturn)
  })

  it('retires the pending lock batch after timeout even when admitted reads reject', async () => {
    const lock = Promise.withResolvers<string>()
    const started = Promise.withResolvers<void>()
    const lockRead = vi.fn(() => lock.promise)
    fs.readdir.mockImplementation(async (file: string) =>
      file === registry ? directories(50) : []
    )
    fs.readFile.mockImplementation(async (file: string) => {
      if (path.basename(file) === 'locked') {
        started.resolve()
        return lockRead()
      }
      return ''
    })
    const pending = probeCreateEventRepoFacts(repo)
    await started.promise
    expect(lockRead).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(1_500)
    expect(await pending).not.toHaveProperty('worktreeCount')

    lock.reject(new Error('Mount stopped responding'))
    await vi.advanceTimersByTimeAsync(0)
    expect(lockRead).toHaveBeenCalledTimes(4)
  })

  it('does not start fact probes after config reads outlive the whole probe', async () => {
    const content = Promise.withResolvers<string>()
    const started = Promise.withResolvers<void>()
    fs.readFile.mockImplementation(async () => {
      started.resolve()
      return content.promise
    })
    const pending = probeCreateEventRepoFacts(repo)
    await started.promise
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await pending).toEqual({ postCheckoutHook: 'unknown' })

    content.resolve('[core]\n bare = false\n')
    await vi.advanceTimersByTimeAsync(0)
    expect(fs.readdir).not.toHaveBeenCalled()
    expect(fs.open).not.toHaveBeenCalled()
    expect(fs.stat).toHaveBeenCalledTimes(1)
  })

  it('does not start config reads after the initial stat outlives the whole probe', async () => {
    const stat = Promise.withResolvers<{ isDirectory: () => boolean }>()
    fs.stat.mockReturnValue(stat.promise)
    const pending = probeCreateEventRepoFacts(repo)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await pending).toEqual({ postCheckoutHook: 'unknown' })

    stat.resolve({ isDirectory: () => true })
    await vi.advanceTimersByTimeAsync(0)
    expect(fs.readFile).not.toHaveBeenCalled()
  })

  it('does not open the index after its directory listing outlives the whole probe', async () => {
    const listing = Promise.withResolvers<string[]>()
    const started = Promise.withResolvers<void>()
    fs.readdir.mockImplementation(async (file: string) => {
      if (file === gitDir) {
        started.resolve()
        return listing.promise
      }
      return []
    })
    const pending = probeCreateEventRepoFacts(repo)
    await started.promise
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await pending).toEqual({ postCheckoutHook: 'unknown' })

    listing.resolve([])
    await vi.advanceTimersByTimeAsync(0)
    expect(fs.open).not.toHaveBeenCalled()
  })

  it('closes an index handle arriving after timeout without reading its header', async () => {
    const handle = Promise.withResolvers<{ read: typeof read; close: typeof close }>()
    const started = Promise.withResolvers<void>()
    fs.open.mockImplementation(() => {
      started.resolve()
      return handle.promise
    })
    const pending = probeCreateEventRepoFacts(repo)
    await started.promise
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await pending).toEqual({ postCheckoutHook: 'unknown' })

    handle.resolve({ read, close })
    await vi.advanceTimersByTimeAsync(0)
    expect(read).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('preserves exact large-registry counts and excludes preparation locks', async () => {
    fs.readdir.mockImplementation(async (file: string) =>
      file === registry ? directories(50) : []
    )
    fs.readFile.mockImplementation(async (file: string) =>
      path.basename(file) === 'locked' && Number(path.basename(path.dirname(file))) % 3 === 0
        ? 'orca-create-preparation:v1:123:old-session\n'
        : ''
    )
    expect(await probeCreateEventRepoFacts(repo)).toEqual({
      postCheckoutHook: 'absent',
      indexEntryCount: 11,
      worktreeCount: 34
    })
    expect(
      fs.readFile.mock.calls.filter(([file]) => path.basename(file) === 'locked')
    ).toHaveLength(50)
    expect(close).toHaveBeenCalledTimes(1)
  })
})
