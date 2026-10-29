// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { useRef, useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'
import type { AppState } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { attachEditorAutosaveController } from '@/components/editor/editor-autosave-controller'
import { createEditorStore } from '@/components/editor/editor-autosave-controller-test-fixture'
import {
  ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT,
  notifyEditorExternalFileChange,
  type EditorPathMutationTarget
} from '@/components/editor/editor-autosave'
import { notifyEditorExternalFileChanges } from '@/components/editor/editor-external-file-notifications'
import { __clearSelfWriteRegistryForTests } from '@/components/editor/editor-self-write-registry'
import { useEditorPanelExternalContentEvents } from '@/components/editor/useEditorPanelExternalContentEvents'
import type { DiffContent, FileContent } from '@/components/editor/editor-panel-content-types'
import { useSourceControlEntryMutations } from './use-entry-mutations'

const mocks = vi.hoisted(
  (): {
    store: StoreApi<AppState> | null
    discard: ReturnType<typeof vi.fn>
  } => ({ store: null, discard: vi.fn() })
)
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => {
      if (!mocks.store) {
        throw new Error('Expected editor store')
      }
      return mocks.store.getState()
    }
  }
}))
vi.mock('@/lib/connection-context', () => ({
  getConnectionId: () => undefined,
  getConnectionIdForFile: () => undefined
}))
vi.mock('@/runtime/runtime-git-working-tree-client', () => ({
  bulkDiscardRuntimeGitPaths: mocks.discard,
  discardRuntimeGitPath: mocks.discard,
  stageRuntimeGitPath: vi.fn(),
  unstageRuntimeGitPath: vi.fn(),
  bulkUnstageRuntimeGitPaths: vi.fn()
}))

const cleanups: (() => void)[] = []
beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  __clearSelfWriteRegistryForTests()
})
afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    cleanup()
  }
  __clearSelfWriteRegistryForTests()
  vi.useRealTimers()
  mocks.store = null
})

function editorStore(): StoreApi<AppState> {
  const store = createEditorStore()
  store.setState({
    worktreesByRepo: {
      'repo-1': ['wt-1', 'wt-2'].map((id) =>
        makeWorktree({ id, repoId: 'repo-1', path: '/repo', hostId: 'local' })
      )
    }
  })
  mocks.store = store
  return store
}

function mountPanel(files: OpenFile[], visible = false) {
  const calls = {
    invalidate: vi.fn<(ids: string[]) => void>(),
    invalidateDiff: vi.fn<(ids: string[]) => void>(),
    loadFile: vi.fn(async () => undefined),
    loadDiff: vi.fn(async () => undefined)
  }
  const hook = renderHook(() => {
    const activeContentFileIdRef = useRef<string | null>(files[0]?.id ?? null)
    const isVisibleRef = useRef(visible)
    const openFilesRef = useRef(files)
    const editorViewModeRef = useRef({})
    const [, setFileContents] = useState<Record<string, FileContent>>({})
    const [, setDiffContents] = useState<Record<string, DiffContent>>({})
    useEditorPanelExternalContentEvents({
      activeContentFileIdRef,
      isVisibleRef,
      openFilesRef,
      editorViewModeRef,
      setFileContents,
      setDiffContents,
      invalidateContent: calls.invalidate,
      invalidateDiffContent: calls.invalidateDiff,
      loadFileContent: calls.loadFile,
      loadDiffContent: calls.loadDiff
    })
  })
  cleanups.push(hook.unmount)
  return calls
}

for (const [pathCount, tabCount] of [
  [0, 100],
  [10, 100],
  [100, 1000]
]) {
  it(`bulk hook indexes ${tabCount} tabs once per stable store/panel snapshot for ${pathCount} unmatched paths`, async () => {
    const store = editorStore()
    const files: OpenFile[] = Array.from({ length: tabCount }, (_, index) => ({
      id: `file-${index}`,
      filePath: `/repo/file-${index}.ts`,
      relativePath: `file-${index}.ts`,
      worktreeId: 'wt-1',
      language: 'typescript',
      mode: 'edit',
      isDirty: false
    }))
    store.setState({ openFiles: files })
    cleanups.push(attachEditorAutosaveController(store))
    let matchingVisits = 0
    const currentFiles = store.getState().openFiles
    for (const file of currentFiles) {
      const owner = file.worktreeId
      Object.defineProperty(file, 'worktreeId', {
        configurable: true,
        get: () => {
          matchingVisits++
          return owner
        }
      })
    }
    const panels = [
      mountPanel(currentFiles.slice(0, tabCount / 2)),
      mountPanel(currentFiles.slice(tabCount / 2))
    ]
    const selected = Array.from({ length: pathCount }, (_, index) => `missing-${index}.ts`)
    const notified: string[] = []
    const listener = (event: Event): void => {
      if (!(event instanceof CustomEvent)) {
        throw new Error('Expected custom event')
      }
      const target: EditorPathMutationTarget = event.detail
      notified.push(target.relativePath)
    }
    window.addEventListener(ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT, listener)
    cleanups.push(() =>
      window.removeEventListener(ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT, listener)
    )
    mocks.discard.mockImplementation(async () => {
      matchingVisits = 0
    })
    const hook = renderHook(() =>
      useSourceControlEntryMutations({
        activeRepoTarget: { kind: 'local' },
        activeWorktreeId: 'wt-1',
        worktreePath: '/repo',
        refreshActiveGitStatusAfterMutation: async () => {}
      })
    )
    cleanups.push(hook.unmount)

    await act(async () => hook.result.current.discardMany(selected))

    expect(matchingVisits).toBe(pathCount === 0 ? 0 : tabCount * 2)
    expect(notified).toEqual(selected)
    expect(mocks.discard).toHaveBeenCalledTimes(1)
    expect(mocks.discard.mock.calls[0]?.[1]).toBe(selected)
    expect(store.getState().openFiles).toBe(currentFiles)
    for (const panel of panels) {
      expect(panel.loadFile).not.toHaveBeenCalled()
      expect(panel.loadDiff).not.toHaveBeenCalled()
      expect(panel.invalidate).not.toHaveBeenCalled()
      expect(panel.invalidateDiff).not.toHaveBeenCalled()
    }
  })
}

for (const indexed of [false, true]) {
  it(`${indexed ? 'indexed' : 'scalar'} notifications preserve dirty drafts and hidden sibling invalidation`, () => {
    const store = editorStore()
    for (const [worktreeId, relativePath] of [
      ['wt-1', 'clean.ts'],
      ['wt-2', 'clean.ts'],
      ['wt-1', 'dirty.ts'],
      ['wt-2', 'dirty.ts']
    ]) {
      store.getState().openFile({
        filePath: `/repo/${relativePath}`,
        relativePath,
        worktreeId,
        language: 'typescript',
        mode: 'edit'
      })
    }
    const dirty = store.getState().openFiles.find((file) => file.relativePath === 'dirty.ts')
    if (!dirty) {
      throw new Error('Expected dirty tab')
    }
    store.getState().setEditorDraft(dirty.id, 'preserved draft')
    store.getState().markFileDirty(dirty.id, true)
    cleanups.push(attachEditorAutosaveController(store))
    const panelFiles = store.getState().openFiles.filter((file) => file.worktreeId === 'wt-2')
    const panel = mountPanel(panelFiles)
    const scope = { worktreeId: 'wt-1', worktreePath: '/repo', runtimeEnvironmentId: null }
    const paths = ['clean.ts', 'dirty.ts', 'missing.ts', 'clean.ts']

    act(() => {
      if (indexed) {
        notifyEditorExternalFileChanges(scope, paths)
      } else {
        for (const relativePath of paths) {
          notifyEditorExternalFileChange({ ...scope, relativePath })
        }
      }
    })

    const cleanSibling = panelFiles.find((file) => file.relativePath === 'clean.ts')
    expect(panel.invalidate.mock.calls).toEqual([[[cleanSibling?.id]], [[cleanSibling?.id]]])
    expect(panel.loadFile).not.toHaveBeenCalled()
    expect(store.getState().editorDrafts[dirty.id]).toBe('preserved draft')
    expect(store.getState().openFiles.find((file) => file.id === dirty.id)?.externalMutation).toBe(
      'changed'
    )
  })
}
