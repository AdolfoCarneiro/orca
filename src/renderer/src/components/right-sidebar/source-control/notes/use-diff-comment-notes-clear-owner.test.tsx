// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from 'zustand'
import type { StoreApi } from 'zustand/vanilla'
import type { AppState } from '@/store/types'
import {
  createTestStore,
  makeTab,
  makeWorktree,
  TEST_REPO
} from '@/store/slices/store-test-helpers'
import { registerWorkspaceShortcutIpcBridge } from '@/hooks/ipc-events/workspace-shortcut-ipc-bridge'
import { setVisibleWorktreeShortcutTargets } from '@/components/sidebar/visible-worktrees'
import { resolveWindowShortcutAction } from '../../../../../../shared/window-shortcut-policy'
import type { DiffComment } from '../../../../../../shared/diff-comment-types'
import { useSourceControlDiffCommentNotes } from './use-diff-comment-notes'

const holder = vi.hoisted((): { store: StoreApi<AppState> | null } => ({ store: null }))
const boundary = vi.hoisted(() => ({ updateMeta: vi.fn(), toastError: vi.fn() }))

function getStore(): StoreApi<AppState> {
  if (!holder.store) {
    throw new Error('Expected a test store')
  }
  return holder.store
}

vi.mock('@/store', async () => {
  const { useStore } = await import('zustand')
  return {
    useAppStore: Object.assign(
      <T,>(selector: (state: AppState) => T) => useStore(getStore(), selector),
      {
        getState: () => getStore().getState(),
        setState: (...args: Parameters<StoreApi<AppState>['setState']>) =>
          getStore().setState(...args)
      }
    )
  }
})
vi.mock('sonner', () => ({
  toast: {
    error: boundary.toastError,
    message: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    info: vi.fn()
  }
}))
vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }))

const A = 'repo1::/repo1/a'
const B = 'repo1::/repo1/b'
let jump: ((index: number) => void) | null = null
const unsubs: (() => void)[] = []

function deferred() {
  let resolve: (value: Record<string, unknown>) => void = () => {}
  let reject: (error: Error) => void = () => {}
  const promise = new Promise<Record<string, unknown>>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

function note(owner: string): DiffComment {
  return {
    id: `note-${owner}`,
    worktreeId: owner,
    filePath: 'file.ts',
    lineNumber: 1,
    body: 'Review this',
    createdAt: 1,
    side: 'modified',
    source: 'diff'
  }
}

function setup() {
  const first = deferred()
  const second = deferred()
  boundary.updateMeta.mockImplementation(({ worktreeId }: { worktreeId: string }) =>
    worktreeId === A ? first.promise : second.promise
  )
  const store = createTestStore()
  holder.store = store
  store.setState({
    repos: [TEST_REPO],
    worktreesByRepo: {
      repo1: [
        makeWorktree({
          id: A,
          repoId: 'repo1',
          path: '/repo1/a',
          hostId: 'local',
          diffComments: [note(A)]
        }),
        makeWorktree({
          id: B,
          repoId: 'repo1',
          path: '/repo1/b',
          hostId: 'local',
          diffComments: [note(B)]
        })
      ]
    },
    tabsByWorktree: {
      [A]: [makeTab({ id: 'tab-a', worktreeId: A, ptyId: 'pty-a' })],
      [B]: [makeTab({ id: 'tab-b', worktreeId: B, ptyId: 'pty-b' })]
    },
    ptyIdsByTabId: { 'tab-a': ['pty-a'], 'tab-b': ['pty-b'] },
    activeTabIdByWorktree: { [A]: 'tab-a', [B]: 'tab-b' },
    activeRepoId: 'repo1',
    activeWorktreeId: A,
    activeWorkspaceKey: `worktree:${A}`,
    activeWorkspaceExecutionHostId: 'local',
    activeView: 'terminal',
    activeModal: 'none',
    rightSidebarOpen: true,
    rightSidebarTab: 'source-control',
    rightSidebarTabByWorktree: { [A]: 'source-control', [B]: 'source-control' },
    everActivatedWorktreeIds: new Set([A, B]),
    refreshGitHubForWorktreeIfStale: vi.fn()
  })
  setVisibleWorktreeShortcutTargets([
    { id: A, executionHostId: 'local' },
    { id: B, executionHostId: 'local' }
  ])
  registerWorkspaceShortcutIpcBridge(unsubs)
  const rendered = renderHook(() => {
    const activeWorktreeId = useStore(store, (state) => state.activeWorktreeId)
    return useSourceControlDiffCommentNotes({
      activeWorktreeId,
      clearDiffComments: store.getState().clearDiffComments,
      clearDiffCommentsForFile: store.getState().clearDiffCommentsForFile
    })
  })
  function jumpToWorkspace(index: number) {
    const digit = index + 1
    const action = resolveWindowShortcutAction(
      { type: 'keyDown', code: `Digit${digit}`, key: `${digit}`, control: true },
      'linux'
    )
    expect(action).toEqual({ type: 'jumpToWorktreeIndex', index })
    if (action?.type !== 'jumpToWorktreeIndex' || !jump) {
      throw new Error('Expected the production workspace shortcut')
    }
    const onJump = jump
    act(() => onJump(action.index))
    expect(store.getState().activeWorktreeId).toBe(index === 0 ? A : B)
  }
  function openConfirmation(worktreeId: string, kind: 'all' | 'file' = 'all') {
    act(() => {
      rendered.result.current.setPendingDiffCommentsClear(
        kind === 'all' ? { kind, worktreeId } : { kind, worktreeId, filePath: 'file.ts' }
      )
    })
  }
  function startClear() {
    let request = Promise.resolve()
    act(() => {
      request = rendered.result.current.handleConfirmDiffCommentsClear()
    })
    return request
  }
  return { ...rendered, store, first, second, jumpToWorkspace, openConfirmation, startClear }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const ui = new Proxy(
    {
      set: vi.fn().mockResolvedValue(undefined),
      recordFeatureInteraction: vi.fn().mockResolvedValue({ featureInteractions: {} }),
      onJumpToWorktreeIndex: (listener: (index: number) => void) => {
        jump = listener
        return () => {
          jump = null
        }
      }
    },
    {
      get: (target, key) => {
        if (
          key === 'set' ||
          key === 'recordFeatureInteraction' ||
          key === 'onJumpToWorktreeIndex'
        ) {
          return target[key]
        }
        return () => () => {}
      }
    }
  )
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      ui,
      worktrees: { updateMeta: boundary.updateMeta },
      settings: { set: vi.fn().mockResolvedValue(undefined) }
    }
  })
})

afterEach(() => {
  cleanup()
  for (const unsubscribe of unsubs.splice(0)) {
    unsubscribe()
  }
  setVisibleWorktreeShortcutTargets(null)
  holder.store = null
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('clear notes confirmation ownership', () => {
  it('closes the unchanged confirmation after its clear succeeds', async () => {
    const { result, store, first, openConfirmation, startClear } = setup()
    openConfirmation(A)
    const request = startClear()
    expect(result.current.isClearingDiffComments).toBe(true)
    await act(async () => {
      first.resolve({})
      await request
    })
    expect(result.current.resolvedPendingDiffCommentsClear).toBeNull()
    expect(result.current.isClearingDiffComments).toBe(false)
    expect(store.getState().getDiffComments(A)).toEqual([])
    expect(store.getState().getDiffComments(B)).toEqual([note(B)])
  })

  it('retains the unchanged confirmation and reports a failed clear', async () => {
    const { result, store, first, openConfirmation, startClear } = setup()
    openConfirmation(A)
    const request = startClear()
    await act(async () => {
      first.reject(new Error('Save failed'))
      await request
    })
    expect(result.current.resolvedPendingDiffCommentsClear?.worktreeId).toBe(A)
    expect(result.current.isClearingDiffComments).toBe(false)
    expect(store.getState().getDiffComments(A)).toEqual([note(A)])
    expect(boundary.toastError).toHaveBeenCalledWith('Failed to clear notes.')
  })

  it('preserves a later confirmation when an earlier file clear succeeds', async () => {
    const { result, first, jumpToWorkspace, openConfirmation, startClear } = setup()
    openConfirmation(A, 'file')
    const request = startClear()
    jumpToWorkspace(1)
    openConfirmation(B)
    await act(async () => {
      first.resolve({})
      await request
    })
    expect(result.current.resolvedPendingDiffCommentsClear?.worktreeId).toBe(B)
  })

  it.each(['success', 'failure'] as const)(
    'keeps the next workspace clear pending after earlier %s',
    async (outcome) => {
      const { result, first, second, jumpToWorkspace, openConfirmation, startClear } = setup()
      openConfirmation(A)
      const older = startClear()
      jumpToWorkspace(1)
      openConfirmation(B)
      const newer = startClear()
      expect(result.current.isClearingDiffComments).toBe(true)
      try {
        await act(async () => {
          if (outcome === 'success') {
            first.resolve({})
          } else {
            first.reject(new Error('Save failed'))
          }
          await older
        })
        expect.soft(result.current.isClearingDiffComments).toBe(true)
        expect(result.current.resolvedPendingDiffCommentsClear?.worktreeId).toBe(B)
        if (outcome === 'failure') {
          expect(boundary.toastError).toHaveBeenCalledWith('Failed to clear notes.')
        }
      } finally {
        await act(async () => {
          second.resolve({})
          await newer
        })
      }
    }
  )

  it('preserves a new confirmation after leaving and returning to the original workspace', async () => {
    const { result, store, first, jumpToWorkspace, openConfirmation, startClear } = setup()
    openConfirmation(A)
    const older = startClear()
    jumpToWorkspace(1)
    let added = Promise.resolve<DiffComment | null>(null)
    act(() => {
      added = store.getState().addDiffComment({
        worktreeId: A,
        filePath: 'later.ts',
        lineNumber: 2,
        body: 'A later note',
        side: 'modified',
        source: 'diff'
      })
    })
    jumpToWorkspace(0)
    openConfirmation(A)
    await act(async () => {
      first.resolve({})
      await older
      await added
    })
    expect(result.current.resolvedPendingDiffCommentsClear?.worktreeId).toBe(A)
    expect(result.current.pendingDiffCommentsClearCount).toBe(1)
  })

  it.each(['success', 'failure'] as const)(
    'finishes persistence and retains failure feedback after unmount: %s',
    async (outcome) => {
      const { store, unmount, first, openConfirmation, startClear } = setup()
      openConfirmation(A)
      const request = startClear()
      unmount()
      await act(async () => {
        if (outcome === 'success') {
          first.resolve({})
        } else {
          first.reject(new Error('Save failed'))
        }
        await request
      })
      expect(store.getState().getDiffComments(A)).toEqual(outcome === 'success' ? [] : [note(A)])
      if (outcome === 'failure') {
        expect(boundary.toastError).toHaveBeenCalledWith('Failed to clear notes.')
      } else {
        expect(boundary.toastError).not.toHaveBeenCalled()
      }
    }
  )
})
