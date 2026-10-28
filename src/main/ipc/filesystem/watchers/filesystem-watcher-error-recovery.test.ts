import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Event as WatcherEvent } from '@parcel/watcher'
import { createWatcherSender, fireWatcherSenderEvent } from './filesystem-watcher-test-sender'

const { statMock, subscribeMock, handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, args: unknown) => Promise<void>>(),
  statMock: vi.fn(),
  subscribeMock: vi.fn()
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args: unknown) => Promise<void>) =>
      handlers.set(channel, handler)
  }
}))
vi.mock('node:fs/promises', () => ({ stat: statMock }))
vi.mock('../watcher-process/parcel-watcher-process', () => ({
  subscribeViaWatcherProcess: subscribeMock,
  disposeWatcherProcess: vi.fn()
}))
vi.mock('./filesystem-watcher-wsl', () => ({ createWslWatcher: vi.fn() }))

import { unsubscribeLocalWatcher } from './filesystem-watcher-local-subscription'
import { registerFilesystemWatcherHandlers } from './filesystem-watcher-handlers'
import { closeAllWatchers } from './filesystem-watcher-shutdown'
import { watcherLifecycleState } from './filesystem-watcher-lifecycle-state'
import { WatcherProcessFailure } from '../watcher-process/parcel-watcher-process-failure'

const ROOT = '/tmp/local-error-recovery'
const RETRY_MS = 5_000

type Callback = (error: Error | null, events: WatcherEvent[]) => void

describe('local watcher terminal error recovery', () => {
  async function watch(sender: ReturnType<typeof createWatcherSender>): Promise<void> {
    const handler = handlers.get('fs:watchWorktree')
    if (!handler) {
      throw new Error('watch handler not registered')
    }
    await handler({ sender }, { worktreePath: ROOT })
  }

  let callbacks: Callback[]
  let unsubscribe: ReturnType<typeof vi.fn>
  let settleRetirements: (() => void)[]

  function heldRetirement() {
    const held = Promise.withResolvers<void>()
    settleRetirements.push(held.resolve)
    return held
  }

  beforeEach(async () => {
    await closeAllWatchers()
    registerFilesystemWatcherHandlers()
    callbacks = []
    settleRetirements = []
    unsubscribe = vi.fn().mockResolvedValue(undefined)
    statMock.mockReset().mockResolvedValue({ isDirectory: () => true })
    subscribeMock.mockReset().mockImplementation(async (_path: string, callback: Callback) => {
      callbacks.push(callback)
      return { unsubscribe }
    })
    vi.useFakeTimers()
  })

  afterEach(async () => {
    for (const settle of settleRetirements) {
      settle()
    }
    await Promise.resolve()
    await closeAllWatchers()
    vi.useRealTimers()
  })

  it('reinstalls one shared root and delivers later events to both surviving senders', async () => {
    const senders = [createWatcherSender(1), createWatcherSender(2)]
    await Promise.all(senders.map((sender) => watch(sender)))
    expect(subscribeMock).toHaveBeenCalledOnce()
    callbacks[0](new Error('native watcher stopped'), [])
    callbacks[0](new Error('duplicate stale error'), [])
    await vi.advanceTimersByTimeAsync(RETRY_MS)
    expect(subscribeMock).toHaveBeenCalledTimes(2)
    expect(unsubscribe).toHaveBeenCalledOnce()
    for (const sender of senders) {
      expect(sender.send).toHaveBeenCalledWith('fs:changed', {
        worktreePath: ROOT,
        events: [{ kind: 'overflow', absolutePath: ROOT }],
        resync: true
      })
      sender.send.mockClear()
    }
    callbacks[1](null, [{ type: 'update', path: `${ROOT}/live.ts` }])
    await vi.advanceTimersByTimeAsync(200)
    for (const sender of senders) {
      expect(sender.send).toHaveBeenCalledWith('fs:changed', {
        worktreePath: ROOT,
        events: [{ kind: 'update', absolutePath: `${ROOT}/live.ts`, isDirectory: true }]
      })
    }
  })

  it('waits for retirement before arming recovery and preserves only remaining owners', async () => {
    const retirement = heldRetirement()
    unsubscribe.mockReturnValueOnce(retirement.promise)
    const first = createWatcherSender(1)
    const survivor = createWatcherSender(2)
    await watch(first)
    await watch(survivor)
    callbacks[0](new Error('stopped'), [])
    unsubscribeLocalWatcher(ROOT, first.id)
    await vi.advanceTimersByTimeAsync(RETRY_MS * 2)
    expect(subscribeMock).toHaveBeenCalledOnce()
    retirement.resolve()
    await vi.advanceTimersByTimeAsync(RETRY_MS)
    expect(subscribeMock).toHaveBeenCalledTimes(2)
    expect(watcherLifecycleState.watchedRoots.get(ROOT)?.listeners.size).toBe(1)
    expect(watcherLifecycleState.watchedRoots.get(ROOT)?.listeners.has(survivor.id)).toBe(true)
  })

  it.each([
    ['unwatch', 'retirement'],
    ['reload', 'retirement'],
    ['shutdown', 'retirement'],
    ['unwatch', 'cooldown'],
    ['reload', 'cooldown'],
    ['shutdown', 'cooldown']
  ])('cancels deferred recovery on %s during %s', async (action, phase) => {
    const sender = createWatcherSender(1)
    await watch(sender)
    callbacks[0](new Error('stopped'), [])
    if (phase === 'cooldown') {
      await vi.advanceTimersByTimeAsync(1_000)
    }
    if (action === 'unwatch') {
      unsubscribeLocalWatcher(ROOT, sender.id)
    } else if (action === 'reload') {
      fireWatcherSenderEvent(sender, 'render-process-gone')
    } else {
      await closeAllWatchers()
    }
    await vi.advanceTimersByTimeAsync(RETRY_MS * 2)
    expect(subscribeMock).toHaveBeenCalledOnce()
    expect(watcherLifecycleState.pendingLocalCapacityRetries.size).toBe(0)
  })

  it('retains the physical-exit barrier after a timed-out retirement', async () => {
    const physicalExit = heldRetirement()
    const failure = new WatcherProcessFailure(
      'still exiting',
      'supervisor',
      'process_unavailable',
      physicalExit.promise
    )
    unsubscribe.mockRejectedValueOnce(failure)
    await watch(createWatcherSender(1))
    callbacks[0](failure, [])
    await vi.advanceTimersByTimeAsync(RETRY_MS * 2)
    expect(subscribeMock).toHaveBeenCalledOnce()
    physicalExit.resolve()
    await vi.advanceTimersByTimeAsync(RETRY_MS)
    expect(subscribeMock).toHaveBeenCalledTimes(2)
  })

  it.each(['retirement', 'cooldown'])(
    'joins a new sender during %s without bypassing the wait',
    async (phase) => {
      const retirement = heldRetirement()
      unsubscribe.mockReturnValueOnce(retirement.promise)
      await watch(createWatcherSender(1))
      callbacks[0](new Error('stopped'), [])
      if (phase === 'cooldown') {
        retirement.resolve()
        await vi.advanceTimersByTimeAsync(1_000)
      }
      const joining = createWatcherSender(2)
      await watch(joining)
      expect(subscribeMock).toHaveBeenCalledOnce()
      if (phase === 'retirement') {
        await vi.advanceTimersByTimeAsync(RETRY_MS)
        expect(subscribeMock).toHaveBeenCalledOnce()
        retirement.resolve()
        await vi.advanceTimersByTimeAsync(RETRY_MS)
      } else {
        await vi.advanceTimersByTimeAsync(RETRY_MS - 1_001)
        expect(subscribeMock).toHaveBeenCalledOnce()
        await vi.advanceTimersByTimeAsync(1)
      }
      expect(subscribeMock).toHaveBeenCalledTimes(2)
      expect(watcherLifecycleState.watchedRoots.get(ROOT)?.listeners.size).toBe(2)
    }
  )

  it('does not recreate a missing root or spin when replacement setup fails', async () => {
    await watch(createWatcherSender(1))
    callbacks[0](new Error('root removed'), [])
    statMock.mockRejectedValueOnce(new Error('ENOENT'))
    await vi.advanceTimersByTimeAsync(RETRY_MS * 10)
    expect(subscribeMock).toHaveBeenCalledOnce()
    expect(watcherLifecycleState.pendingLocalCapacityRetries.size).toBe(0)
  })
})
