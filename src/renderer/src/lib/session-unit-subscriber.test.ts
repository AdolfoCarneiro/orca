import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../store'
import type { AppState } from '../store/types'
import { createSessionUnitSubscriber } from './session-unit-subscriber'
import { SessionUnitWriter } from './session-unit-writer'
import type { WorkspaceSessionPatch } from '../../../shared/workspace-session-state-types'

function storeFixture() {
  let current = {
    ...useAppStore.getState(),
    workspaceSessionReady: true,
    hydrationSucceeded: true,
    lastVisitedAtByWorktreeId: {},
    repos: [],
    worktreesByRepo: {},
    openFiles: [],
    tabsByWorktree: {},
    terminalLayoutsByTabId: {}
  }
  let listener: ((state: AppState) => void) | undefined
  return {
    getState: () => current,
    subscribe: (callback: (state: AppState) => void) => {
      listener = callback
      return () => {
        listener = undefined
      }
    },
    edit: (value: Record<string, number>) => {
      current = { ...current, lastVisitedAtByWorktreeId: value }
      listener?.(current)
    }
  }
}

afterEach(() => vi.useRealTimers())
describe('subscriber source and ACK lifetimes', () => {
  it('coalesces interleaved edits during flight and retains a removal across failure', async () => {
    vi.useFakeTimers()
    const store = storeFixture()
    let resolve: ((value: { applied: boolean; partitionGeneration: string }) => void) | undefined
    let reject: ((error: Error) => void) | undefined
    let blocked = false
    const patch = vi.fn(async (_patch: WorkspaceSessionPatch) => {
      if (blocked) {
        return new Promise<{ applied: boolean; partitionGeneration: string }>((yes, no) => {
          resolve = yes
          reject = no
        })
      }
      return { applied: true, partitionGeneration: 'applied' }
    })
    const error = vi.fn()
    const stop = createSessionUnitSubscriber({
      store,
      writer: new SessionUnitWriter({ patch }),
      debounceMs: 1,
      onPersistError: error
    })
    await vi.advanceTimersByTimeAsync(1)
    patch.mockClear()
    blocked = true
    store.edit({ a: 1 })
    await vi.advanceTimersByTimeAsync(1)
    store.edit({ a: 2 })
    store.edit({})
    resolve?.({ applied: true, partitionGeneration: 'one' })
    await vi.advanceTimersByTimeAsync(1)
    expect(patch.mock.calls[1][0].mapDeltas?.lastVisitedAtByWorktreeId?.remove).toEqual(['a'])
    reject?.(new Error('lost ACK'))
    await vi.advanceTimersByTimeAsync(0)
    expect(error).toHaveBeenCalledOnce()
    const count = patch.mock.calls.length
    await vi.advanceTimersByTimeAsync(1000)
    expect(patch).toHaveBeenCalledTimes(count)
    blocked = false
    store.edit({})
    await vi.advanceTimersByTimeAsync(1)
    expect(patch.mock.calls.at(-1)?.[0].mapDeltas?.lastVisitedAtByWorktreeId?.remove).toEqual(['a'])
    stop()
  })

  it('never arms another flush after disposal of an in-flight send', async () => {
    vi.useFakeTimers()
    const store = storeFixture()
    let resolve: ((value: { applied: boolean; partitionGeneration: string }) => void) | undefined
    const patch = vi.fn(
      () =>
        new Promise<{ applied: boolean; partitionGeneration: string }>((yes) => {
          resolve = yes
        })
    )
    const stop = createSessionUnitSubscriber({
      store,
      writer: new SessionUnitWriter({ patch }),
      debounceMs: 1
    })
    await vi.advanceTimersByTimeAsync(1)
    store.edit({ a: 1 })
    stop()
    resolve?.({ applied: true, partitionGeneration: 'late' })
    await vi.advanceTimersByTimeAsync(100)
    expect(patch).toHaveBeenCalledTimes(1)
  })
})
