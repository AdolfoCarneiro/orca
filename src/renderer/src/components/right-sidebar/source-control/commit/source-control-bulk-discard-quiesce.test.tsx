// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { attachEditorAutosaveController } from '@/components/editor/editor-autosave-controller'
import {
  createEditorStore,
  createFakeEditorDisk,
  withLoadedBaselines
} from '@/components/editor/editor-autosave-controller-test-fixture'
import { __clearSelfWriteRegistryForTests } from '@/components/editor/editor-self-write-registry'
import { registerPendingEditorFlush } from '@/components/editor/editor-pending-flush'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { useSourceControlEntryMutations } from './use-entry-mutations'

const mocks = vi.hoisted(() => ({ bulkDiscard: vi.fn() }))
vi.mock('@/lib/connection-context', () => ({
  getConnectionId: () => undefined,
  getConnectionIdForFile: () => undefined
}))
vi.mock('@/runtime/runtime-git-working-tree-client', () => ({
  bulkDiscardRuntimeGitPaths: mocks.bulkDiscard,
  discardRuntimeGitPath: vi.fn(),
  stageRuntimeGitPath: vi.fn(),
  unstageRuntimeGitPath: vi.fn(),
  bulkUnstageRuntimeGitPaths: vi.fn()
}))

const cleanups: (() => void)[] = []
beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  mocks.bulkDiscard.mockResolvedValue(undefined)
})
afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    cleanup()
  }
  __clearSelfWriteRegistryForTests()
  vi.useRealTimers()
})

function setup(paths: string[], openTabs = paths.length) {
  const disk = createFakeEditorDisk(
    Object.fromEntries(paths.map((path) => [`/repo/${path}`, 'saved']))
  )
  const descriptor = Object.getOwnPropertyDescriptor(window, 'api')
  Object.defineProperty(window, 'api', { configurable: true, value: { fs: disk.fs } })
  cleanups.push(() => {
    if (descriptor) {
      Object.defineProperty(window, 'api', descriptor)
    } else {
      Reflect.deleteProperty(window, 'api')
    }
  })
  const store = createEditorStore()
  store.setState({
    worktreesByRepo: {
      'repo-1': [makeWorktree({ id: 'wt-1', repoId: 'repo-1', path: '/repo', hostId: 'local' })]
    }
  })
  for (let index = 0; index < openTabs; index++) {
    const path = paths[index] ?? `other-${index}.ts`
    store.getState().openFile({
      filePath: `/repo/${path}`,
      relativePath: path,
      worktreeId: 'wt-1',
      language: 'typescript',
      mode: 'edit'
    })
  }
  withLoadedBaselines(store, disk)
  const cleanupController = attachEditorAutosaveController(store)
  cleanups.push(cleanupController)
  const hook = renderHook(() =>
    useSourceControlEntryMutations({
      activeRepoTarget: { kind: 'local' },
      activeWorktreeId: 'wt-1',
      worktreePath: '/repo',
      refreshActiveGitStatusAfterMutation: async () => {}
    })
  )
  cleanups.push(hook.unmount)
  return { disk, store, discard: () => hook.result.current.discardMany(paths) }
}

it('holds a bulk discard with one backstop and releases once Git settles', async () => {
  const paths = Array.from({ length: 10 }, (_, index) => `f${index}.ts`)
  const { store, disk, discard } = setup(paths, 100)
  let finishGit: () => void = () => {}
  mocks.bulkDiscard.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finishGit = resolve
      })
  )
  let pending: Promise<void> = Promise.resolve()
  await act(async () => {
    pending = discard()
    await Promise.resolve()
    await Promise.resolve()
  })
  expect(mocks.bulkDiscard).toHaveBeenCalledTimes(1)
  expect(mocks.bulkDiscard.mock.calls[0]?.[1]).toEqual(paths)
  const holdTimers = vi.getTimerCount()
  for (const file of store.getState().openFiles.slice(0, paths.length)) {
    store.getState().setEditorDraft(file.id, 'during discard')
    store.getState().markFileDirty(file.id, true)
  }
  await vi.advanceTimersByTimeAsync(5_000)
  expect(disk.fs.writeFile).not.toHaveBeenCalled()
  await act(async () => {
    finishGit()
    await pending
  })
  expect(vi.getTimerCount()).toBe(0)
  expect(holdTimers).toBe(1)
})

it('empty bulk discard does not acquire an editor hold', async () => {
  const { discard } = setup([], 10)
  await act(async () => {
    await discard()
  })
  expect(vi.getTimerCount()).toBe(0)
})

it('waits for every pending save before a failed quiesce releases other paths', async () => {
  const { store, disk, discard } = setup(['blocked.ts', 'pending.ts'])
  const [blocked, pendingFile] = store.getState().openFiles
  let finishWrite: () => void = () => {}
  disk.fs.writeFile.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishWrite = () => resolve({ ok: true })
      })
  )
  store.getState().setEditorDraft(pendingFile.id, 'pending write')
  store.getState().markFileDirty(pendingFile.id, true)
  await vi.advanceTimersByTimeAsync(1_000)
  expect(disk.fs.writeFile).toHaveBeenCalledTimes(1)
  const unregister = registerPendingEditorFlush(
    blocked.id,
    () => {
      throw new Error('pending cell edit')
    },
    () => true
  )
  cleanups.push(unregister)
  const existingTimers = vi.getTimerCount()
  let settled = false
  const outcome = discard().then(
    () => {
      settled = true
      return ''
    },
    (error: unknown) => {
      settled = true
      return String(error)
    }
  )
  await Promise.resolve()
  await Promise.resolve()
  expect(settled).toBe(false)
  expect(mocks.bulkDiscard).not.toHaveBeenCalled()
  const holdTimers = vi.getTimerCount() - existingTimers
  finishWrite()
  expect(await outcome).toContain('pending cell edit')
  expect(holdTimers).toBe(1)
  expect(vi.getTimerCount()).toBe(existingTimers)
  expect(mocks.bulkDiscard).not.toHaveBeenCalled()
})
