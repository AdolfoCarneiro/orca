// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { useSourceControlEntryMutations } from '@/components/right-sidebar/source-control/commit/use-entry-mutations'
import { attachEditorAutosaveController } from './editor-autosave-controller'
import { createEditorStore, createFakeEditorDisk } from './editor-autosave-controller-test-fixture'
import {
  __clearSelfWriteRegistryForTests,
  getRecentSelfWrite,
  recordSelfWrite
} from './editor-self-write-registry'
import { ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT } from './editor-autosave'

const mocks = vi.hoisted(() => ({ git: vi.fn() }))
vi.mock('@/lib/connection-context', () => ({
  getConnectionId: () => undefined,
  getConnectionIdForFile: () => undefined
}))
vi.mock('@/lib/desktop-window-chrome', async (original) => ({
  ...(await original<object>()),
  isLocalWindowsDesktopClient: () => true
}))
vi.mock('@/runtime/runtime-git-working-tree-client', () => ({
  bulkDiscardRuntimeGitPaths: mocks.git,
  discardRuntimeGitPath: mocks.git,
  stageRuntimeGitPath: vi.fn(),
  unstageRuntimeGitPath: vi.fn(),
  bulkUnstageRuntimeGitPaths: vi.fn()
}))

const cleanups: (() => void)[] = []
beforeEach(() => {
  vi.useFakeTimers()
  mocks.git.mockReset().mockResolvedValue(undefined)
  __clearSelfWriteRegistryForTests()
  const descriptor = Object.getOwnPropertyDescriptor(window, 'api')
  const disk = createFakeEditorDisk()
  Object.defineProperty(window, 'api', { configurable: true, value: { fs: disk.fs } })
  cleanups.push(() => {
    if (descriptor) {
      Object.defineProperty(window, 'api', descriptor)
    } else {
      Reflect.deleteProperty(window, 'api')
    }
  })
})
afterEach(() => {
  for (const dispose of cleanups.splice(0).toReversed()) {
    dispose()
  }
  __clearSelfWriteRegistryForTests()
  vi.useRealTimers()
})

function tab(patch: Partial<OpenFile>): OpenFile {
  return {
    id: 'selected',
    filePath: '/repo/a.ts',
    relativePath: 'a.ts',
    worktreeId: 'wt-1',
    language: 'typescript',
    mode: 'edit',
    isDirty: false,
    ...patch
  }
}

for (const fixture of [
  {
    name: 'remote owner',
    root: '/repo',
    file: tab({ runtimeEnvironmentId: 'env-1' }),
    owner: 'env-1'
  },
  {
    name: 'WSL physical sibling in another workspace',
    root: '\\\\wsl$\\Ubuntu\\repo',
    file: tab({
      filePath: '\\\\wsl.localhost\\ubuntu\\repo\\a.ts',
      worktreeId: 'wt-other'
    }),
    owner: null
  },
  {
    name: 'unstaged diff with its actual write path',
    root: '/repo',
    file: tab({ filePath: '/actual-editor-path/a.ts', mode: 'diff', diffSource: 'unstaged' }),
    owner: null
  }
]) {
  it(`invalidates the drained ${fixture.name} stamp before notifying consumers`, async () => {
    const store = createEditorStore()
    store.setState({
      openFiles: [fixture.file],
      worktreesByRepo: {
        repo: ['wt-1', 'wt-other'].map((id) =>
          makeWorktree({ id, repoId: 'repo', path: fixture.root, hostId: 'local' })
        )
      }
    })
    recordSelfWrite(fixture.file.filePath, 'drained stamp', fixture.owner)
    recordSelfWrite(fixture.file.filePath, 'unrelated owner', 'env-other')
    const observed: (string | null)[] = []
    const listener = (): void => {
      observed.push(getRecentSelfWrite(fixture.file.filePath, fixture.owner)?.content ?? null)
    }
    window.addEventListener(ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT, listener)
    cleanups.push(() =>
      window.removeEventListener(ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT, listener)
    )
    cleanups.push(attachEditorAutosaveController(store))
    const hook = renderHook(() =>
      useSourceControlEntryMutations({
        activeRepoTarget: fixture.owner
          ? { kind: 'environment', environmentId: fixture.owner }
          : { kind: 'local' },
        activeWorktreeId: 'wt-1',
        worktreePath: fixture.root,
        refreshActiveGitStatusAfterMutation: async () => {}
      })
    )
    cleanups.push(hook.unmount)

    await hook.result.current.discardSingle('a.ts')

    expect(observed).toEqual([null])
    expect(getRecentSelfWrite(fixture.file.filePath, 'env-other')?.content).toBe('unrelated owner')
  })
}

it('captures a closed-file stamp from the target when no controller claims quiesce', async () => {
  recordSelfWrite('/repo/a.ts', 'closed file')
  const hook = renderHook(() =>
    useSourceControlEntryMutations({
      activeRepoTarget: { kind: 'local' },
      activeWorktreeId: 'wt-1',
      worktreePath: '/repo',
      refreshActiveGitStatusAfterMutation: async () => {}
    })
  )
  cleanups.push(hook.unmount)

  await hook.result.current.discardSingle('a.ts')

  expect(getRecentSelfWrite('/repo/a.ts')).toBe(null)
})
