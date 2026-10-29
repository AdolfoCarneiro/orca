import { describe, expect, it, vi } from 'vitest'
import { createStore } from 'zustand/vanilla'
import { useAppStore } from './index'
import type { AppState } from './types'
import { editSessionSource } from './session-source-edits'
import { withSessionSourceWrites } from './session-source-write-boundary'
import {
  discoverSessionSources,
  type SessionSourceDiscovery
} from '../lib/session-source-discovery'
import { createTerminalTabAppearanceActions } from './terminals/terminal-tab-appearance'
import { createTerminalTabAgentLaunchPaneActions } from './terminals/terminal-tab-agent-launch-pane'
import { createTerminalTabPresentationActions } from './terminals/terminal-tab-presentation'
import { createAgentStatusRuntime } from './slices/agent-status/agent-status-runtime'
import { makeTab } from './slices/store-session-test-harness'

vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync: vi.fn() }))
vi.mock('@/runtime/web-runtime-terminal-rename', () => ({ renameHostTerminalTab: vi.fn() }))

function fixture(): AppState {
  const first = makeTab({ id: 'duplicate', worktreeId: 'first' })
  return {
    ...useAppStore.getState(),
    tabsByWorktree: { first: [first, first], last: [{ ...first, worktreeId: 'last' }] },
    unifiedTabsByWorktree: {},
    openFiles: [],
    editorDrafts: {},
    editorBuffers: {},
    sleepingAgentSessionsByPaneKey: {},
    activeWorktreeId: 'first'
  }
}

function verifyTransition(
  before: AppState,
  after: AppState,
  receipt: SessionSourceDiscovery | undefined
): void {
  expect(receipt).toBeDefined()
  expect(receipt?.full).toBe(false)
  expect(receipt?.changes).toEqual(discoverSessionSources(before, after).changes)
}

describe('production source writer receipts', () => {
  it('matches native update-all and first-owner title operations with duplicate occurrences', () => {
    const store = createStore<AppState>()(
      withSessionSourceWrites(
        (set, get) => ({
          ...fixture(),
          ...createTerminalTabAppearanceActions(set, get),
          ...createTerminalTabAgentLaunchPaneActions(set),
          ...createTerminalTabPresentationActions(set, get)
        }),
        true
      )
    )
    let receipt: SessionSourceDiscovery | undefined
    store.subscribe(() => {
      receipt = store.getSessionSourceReceipt()
    })
    const operations = [
      () => store.getState().setTabColor('duplicate', '#fff'),
      () => store.getState().setTabCustomTitle('duplicate', 'renamed'),
      () => store.getState().setTabAgentLaunchPane('duplicate', undefined, { remount: true }),
      () => store.getState().updateTabTitle('duplicate', 'working')
    ]
    for (const operation of operations) {
      const before = store.getState()
      for (const tabs of Object.values(before.tabsByWorktree)) {
        for (const tab of tabs) {
          Object.freeze(tab)
        }
        Object.freeze(tabs)
      }
      Object.freeze(before.tabsByWorktree)
      const frozen = JSON.stringify(before.tabsByWorktree)
      receipt = undefined
      operation()
      verifyTransition(before, store.getState(), receipt)
      expect(JSON.stringify(before.tabsByWorktree)).toBe(frozen)
    }
    expect(store.getState().tabsByWorktree.first.map((tab) => tab.customTitle)).toEqual([
      'renamed',
      'renamed'
    ])
    expect(store.getState().tabsByWorktree.last[0].customTitle).toBe('renamed')
    expect(store.getState().tabsByWorktree.last[0].title).toBe('working')
  })

  it('retains every source edit across a status transaction and runs effects once', () => {
    const store = createStore<AppState>()(withSessionSourceWrites(fixture, true))
    const runtime = createAgentStatusRuntime(store.setState, store.getState, () => store.getState())
    const before = store.getState()
    let receipt: SessionSourceDiscovery | undefined
    let publications = 0
    store.subscribe(() => {
      receipt = store.getSessionSourceReceipt()
      publications++
    })
    const effect = vi.fn()
    runtime.transactAgentStatuses(() => {
      runtime.set(editSessionSource(runtime.get()).set('editorDrafts', 'a', 'first').finish())
      runtime.set(editSessionSource(runtime.get()).set('editorDrafts', 'b', 'second').finish())
      runtime.set(editSessionSource(runtime.get()).remove('editorDrafts', 'a').finish())
      runtime.runAfterCommit(effect)
    })
    expect(publications).toBe(1)
    expect(effect).toHaveBeenCalledOnce()
    expect(store.getState().editorDrafts).toEqual({ b: 'second' })
    expect(before.editorDrafts).toEqual({})
    verifyTransition(before, store.getState(), receipt)
    const published = store.getState()
    expect(() =>
      runtime.transactAgentStatuses(() => {
        runtime.set(
          editSessionSource(runtime.get()).set('editorDrafts', 'discarded', 'value').finish()
        )
        runtime.runAfterCommit(effect)
        throw new Error('abort transaction')
      })
    ).toThrow('abort transaction')
    expect(store.getState()).toBe(published)
    expect(publications).toBe(1)
    expect(effect).toHaveBeenCalledOnce()
  })
})
