// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { useCallback } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCA_WORKTREE_FILE_CHANGE_EVENT } from '@/hooks/worktree-file-change-event'
import { useFileExplorerTree } from '@/components/right-sidebar/useFileExplorerTree'
import { useFileExplorerWatch } from '@/components/right-sidebar/useFileExplorerWatch'
import { useFileExplorerTreeLoadEffects } from '@/components/right-sidebar/use-file-explorer-tree-load-effects'
import { FILE_EXPLORER_RUNTIME_REFRESH_CONCURRENCY } from '@/components/right-sidebar/file-explorer-refresh-concurrency'
import type { DirCache } from '@/components/right-sidebar/file-explorer-types'

const { read, owner } = vi.hoisted(() => ({
  read: vi.fn(),
  owner: { kind: 'runtime', environmentId: 'host-a', executionHostId: 'runtime:host-a' } as const
}))
vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: unknown) => unknown) => selector({ settings: {}, worktreesByRepo: {} }),
    { getState: () => ({ settings: {}, worktreesByRepo: {} }) }
  )
}))
vi.mock('@/components/right-sidebar/file-explorer-directory-listing', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  readFileExplorerDirectory: read
}))
vi.mock('@/components/right-sidebar/file-explorer-operation-owner', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getFileExplorerOperationOwner: () => owner,
  getFileExplorerOperationOwnerFromState: () => owner
}))

function listing(name = 'fresh.txt') {
  return { entries: [{ name, isDirectory: false, isSymlink: false }], operationOwner: owner }
}
async function flush(): Promise<void> {
  for (let index = 0; index < 128; index++) {
    await Promise.resolve()
  }
}
function emitOverflow(): void {
  window.dispatchEvent(
    new CustomEvent(ORCA_WORKTREE_FILE_CHANGE_EVENT, {
      detail: {
        runtimeEnvironmentId: 'host-a',
        payload: { worktreePath: '/repo', events: [{ kind: 'overflow', absolutePath: '/repo' }] }
      }
    })
  )
}
function renderCachedTree(width: number) {
  const expanded = new Set(Array.from({ length: width }, (_, index) => `/repo/dir-${index}`))
  const cache: Record<string, DirCache> = {}
  for (const path of ['/repo', ...expanded]) {
    cache[path] = {
      children: [
        {
          name: 'cached.txt',
          path: `${path}/cached.txt`,
          relativePath: 'cached.txt',
          isDirectory: false,
          isSymlink: false,
          depth: 0
        }
      ],
      operationOwner: owner
    }
  }
  const hook = renderHook(
    ({ visible, expandedPaths }) => {
      const tree = useFileExplorerTree('/repo', expandedPaths, 'wt')
      const resetSelection = useCallback(() => {}, [])
      const setNameFilterQuery = useCallback(() => {}, [])
      useFileExplorerTreeLoadEffects({
        visibleFilesWorktreePath: visible ? '/repo' : null,
        expanded: expandedPaths,
        dirCache: tree.dirCache,
        loadingDirPaths: tree.loadingDirPaths,
        rootError: tree.rootError,
        isDirStale: tree.isDirStale,
        loadDir: tree.loadDir,
        refreshTree: tree.refreshTree,
        resetAndLoad: tree.resetAndLoad,
        resetSelection,
        setNameFilterQuery
      })
      useFileExplorerWatch({
        worktreePath: visible ? '/repo' : null,
        activeWorktreeId: 'wt',
        dirCache: tree.dirCache,
        setDirCache: tree.setDirCache,
        expanded: expandedPaths,
        refreshDir: tree.refreshDir,
        refreshTree: tree.refreshTree,
        setSelectedPath: resetSelection,
        inlineInput: null,
        dragSourcePath: null,
        isNativeDragOver: false,
        operationOwner: owner
      })
      return tree
    },
    { initialProps: { visible: true, expandedPaths: new Set<string>() } }
  )
  return { hook, cache, expanded }
}
async function prepare(width: number) {
  const tree = renderCachedTree(width)
  await act(flush)
  act(() => tree.hook.result.current.setDirCache(tree.cache))
  tree.hook.rerender({ visible: true, expandedPaths: tree.expanded })
  read.mockClear()
  return tree
}
async function reopen(tree: Awaited<ReturnType<typeof prepare>>, width: number): Promise<void> {
  read.mockClear()
  tree.hook.rerender({ visible: true, expandedPaths: tree.expanded })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
    await flush()
  })
  expect(read.mock.calls.map((call) => call[2])).toHaveLength(width + 1)
  expect(tree.hook.result.current.dirCache['/repo/dir-0'].children[0].name).toBe('fresh.txt')
  expect(tree.hook.result.current.loadingDirPaths.size).toBe(0)
}

beforeEach(() => {
  vi.useFakeTimers()
  read.mockReset().mockResolvedValue(listing())
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('watch-owned expanded refresh admission', () => {
  it.each([20, 200])(
    'starts no queued reads after hiding during the root of a %i-dir refresh',
    async (width) => {
      const tree = await prepare(width)
      const held = Promise.withResolvers<ReturnType<typeof listing>>()
      read.mockReturnValueOnce(held.promise)
      act(emitOverflow)
      await act(async () => vi.advanceTimersByTimeAsync(0))
      expect(read.mock.calls.map((call) => call[2])).toEqual(['/repo'])
      tree.hook.rerender({ visible: false, expandedPaths: tree.expanded })
      await act(async () => {
        held.resolve(listing())
        await flush()
      })
      expect(read.mock.calls.map((call) => call[2])).toEqual(['/repo'])
      expect(tree.hook.result.current.dirCache['/repo/dir-0'].children[0].name).toBe('cached.txt')
      await reopen(tree, width)
    }
  )

  it.each([20, 200])('finishes a live %i-dir refresh without cancelling it', async (width) => {
    const tree = await prepare(width)
    act(emitOverflow)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
      await flush()
    })
    expect(read.mock.calls.map((call) => call[2])).toHaveLength(width + 1)
    expect(tree.hook.result.current.dirCache['/repo/dir-0'].children[0].name).toBe('fresh.txt')
    expect(tree.hook.result.current.loadingDirPaths.size).toBe(0)
  })

  it.each([20, 200])('stops the queued part of a %i-dir wave when Files hides', async (width) => {
    const tree = await prepare(width)
    const held = Array.from({ length: FILE_EXPLORER_RUNTIME_REFRESH_CONCURRENCY }, () =>
      Promise.withResolvers<ReturnType<typeof listing>>()
    )
    let admitted = 0
    read.mockImplementation((_id, _root, path) =>
      path === '/repo'
        ? Promise.resolve(listing())
        : (held[admitted++]?.promise ?? Promise.resolve(listing()))
    )
    act(emitOverflow)
    await act(async () => vi.advanceTimersByTimeAsync(0))
    expect(read.mock.calls).toHaveLength(FILE_EXPLORER_RUNTIME_REFRESH_CONCURRENCY + 1)
    tree.hook.rerender({ visible: false, expandedPaths: tree.expanded })
    await act(async () => {
      for (const pending of held) {
        pending.resolve(listing('obsolete.txt'))
      }
      await flush()
    })
    expect(read.mock.calls).toHaveLength(FILE_EXPLORER_RUNTIME_REFRESH_CONCURRENCY + 1)
    expect(tree.hook.result.current.dirCache['/repo/dir-0'].children[0].name).toBe('cached.txt')
    expect(tree.hook.result.current.loadingDirPaths.size).toBe(0)
    read.mockResolvedValue(listing())
    await reopen(tree, width)
  })
})
