import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import {
  getOpenFilesForExternalFileChange,
  notifyEditorExternalFileChange,
  ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT,
  type EditorPathMutationTarget
} from '@/components/editor/editor-autosave'
import {
  createEditorStore,
  stubEditorWindowWithDisk
} from '@/components/editor/editor-autosave-controller-test-fixture'
import { notifyEditorExternalFileChanges } from './editor-external-file-notifications'

const desktop = vi.hoisted(() => ({ windows: false }))
vi.mock('@/lib/desktop-window-chrome', () => ({
  isLocalWindowsDesktopClient: () => desktop.windows
}))
const cleanup: (() => void)[] = []
beforeEach(() => {
  vi.useFakeTimers()
  desktop.windows = false
  stubEditorWindowWithDisk()
})
afterEach(() => {
  for (const dispose of cleanup.splice(0).toReversed()) {
    dispose()
  }
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function captureTargets(
  scope: Omit<EditorPathMutationTarget, 'relativePath' | 'indexedOpenFiles'>,
  paths: readonly string[]
): EditorPathMutationTarget[] {
  const targets: EditorPathMutationTarget[] = []
  const listener = (event: Event): void => {
    if (!(event instanceof CustomEvent)) {
      throw new Error('Expected a custom event')
    }
    targets.push(event.detail)
  }
  window.addEventListener(ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT, listener)
  try {
    notifyEditorExternalFileChanges(scope, paths)
  } finally {
    window.removeEventListener(ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT, listener)
  }
  return targets
}

function file(overrides: Partial<OpenFile> = {}): OpenFile {
  return {
    id: 'file',
    filePath: '/repo/File.ts',
    relativePath: 'File.ts',
    worktreeId: 'wt-1',
    language: 'typescript',
    mode: 'edit',
    isDirty: false,
    ...overrides
  }
}

it('matches the existing filter across owner omission/null/trim, modes, path spellings and Windows alias gating', () => {
  let comparisons = 0
  const roots = ['/repo', 'C:/Repo', '//wsl.localhost/Ubuntu/workspace/repo', '/mnt/c/Repo']
  for (const root of roots) {
    const files: OpenFile[] = []
    for (const path of [
      `${root}/File.ts`,
      `${root}/file.ts`,
      `${root}/a\\b.ts`,
      `${root}/a/b.ts`,
      'c:\\Repo\\File.ts',
      '//wsl$/Ubuntu/mnt/c/Repo/File.ts',
      '//wsl.localhost/Ubuntu/workspace/repo/File.ts'
    ]) {
      for (const owner of [undefined, null, 'env-1', ' env-1 ', 'env-2']) {
        for (const mode of ['edit', 'markdown-preview', 'diff'] as const) {
          for (const diffSource of mode === 'diff'
            ? (['unstaged', 'staged', 'combined-uncommitted', 'commit'] as const)
            : [undefined]) {
            files.push(
              file({
                id: String(files.length),
                filePath: path,
                relativePath: path.endsWith('File.ts') ? 'File.ts' : path.slice(root.length + 1),
                runtimeEnvironmentId: owner,
                mode,
                diffSource
              })
            )
          }
        }
      }
    }
    files.unshift(
      file({ id: 'other-workspace', worktreeId: 'wt-other', filePath: `${root}/File.ts` })
    )
    files.push(files[4])
    for (const owner of [
      {},
      { runtimeEnvironmentId: undefined },
      { runtimeEnvironmentId: null },
      { runtimeEnvironmentId: '' },
      { runtimeEnvironmentId: 'env-1' },
      { runtimeEnvironmentId: ' env-1 ' }
    ]) {
      for (const allow of [false, true]) {
        for (const windows of [false, true]) {
          desktop.windows = windows
          const scope = {
            worktreeId: 'wt-1',
            worktreePath: root,
            ...owner,
            ...(allow ? { allowLocalWindowsWslAliases: true as const } : {})
          }
          const indexed = captureTargets(scope, ['File.ts', 'file.ts', 'a\\b.ts', 'a/b.ts'])
          expect(indexed).toHaveLength(4)
          for (const relativePath of ['File.ts', 'file.ts', 'a\\b.ts', 'a/b.ts']) {
            const target = { ...scope, relativePath }
            const notification = indexed.find((value) => value.relativePath === relativePath)
            if (!notification) {
              throw new Error('Expected notification for each path')
            }
            const actual = getOpenFilesForExternalFileChange(files, notification)
            const expected = getOpenFilesForExternalFileChange(files, target)
            expect(actual).toEqual(expected)
            expect(actual.every((file, index) => file === expected[index])).toBe(true)
            comparisons++
          }
        }
      }
    }
  }
  expect(comparisons).toBe(384)
})

for (const phase of ['baseline', 'indexed']) {
  it(`${phase} preserves synchronous duplicate notifications while actual open/rekey actions change arrays`, () => {
    const store = createEditorStore()
    const events: { relativePath: string; matched: string[] }[] = []
    const arrays: OpenFile[][] = []
    let added = ''
    const listener = (event: Event): void => {
      if (!(event instanceof CustomEvent)) {
        throw new Error('Expected a custom event')
      }
      const target: EditorPathMutationTarget = event.detail
      arrays.push(store.getState().openFiles)
      events.push({
        relativePath: target.relativePath,
        matched: getOpenFilesForExternalFileChange(store.getState().openFiles, target).map(
          (file) => file.id
        )
      })
      if (events.length === 1) {
        added = store.getState().openFile({
          filePath: '/repo/second.ts',
          relativePath: 'second.ts',
          worktreeId: 'wt-1',
          language: 'typescript',
          mode: 'edit'
        })
      } else if (events.length === 2) {
        expect(
          store.getState().rekeyOpenFilesForPathChange({
            rekeys: [
              {
                oldFileId: added,
                newFileId: 'retargeted',
                oldFilePath: '/repo/second.ts',
                newFilePath: '/repo/third.ts',
                newRelativePath: 'third.ts'
              }
            ]
          })
        ).toEqual({ ok: true })
      }
    }
    window.addEventListener(ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT, listener)
    cleanup.push(() => window.removeEventListener(ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT, listener))
    const scope = { worktreeId: 'wt-1', worktreePath: '/repo', runtimeEnvironmentId: null }
    if (phase === 'indexed') {
      notifyEditorExternalFileChanges(scope, ['first.ts', 'second.ts', 'second.ts'])
    } else {
      for (const relativePath of ['first.ts', 'second.ts', 'second.ts']) {
        notifyEditorExternalFileChange({ ...scope, relativePath })
      }
    }
    expect(events).toEqual([
      { relativePath: 'first.ts', matched: [] },
      { relativePath: 'second.ts', matched: [added] },
      { relativePath: 'second.ts', matched: [] }
    ])
    expect(arrays[0]).not.toBe(arrays[1])
    expect(arrays[1]).not.toBe(arrays[2])
  })
}

it('matches stable panel/store arrays separately in the original panel-before-store order', () => {
  const panel = [file({ id: 'preview', mode: 'markdown-preview' }), file({ id: 'edit' })]
  const store = [
    file({ id: 'diff', mode: 'diff', diffSource: 'unstaged' }),
    panel[1],
    file({ id: 'other', runtimeEnvironmentId: 'env-2' })
  ]
  const scope = { worktreeId: 'wt-1', worktreePath: '/repo', runtimeEnvironmentId: null }
  const target = captureTargets(scope, ['File.ts'])[0]
  if (!target) {
    throw new Error('Expected notification')
  }
  expect([
    ...getOpenFilesForExternalFileChange(panel, target),
    ...getOpenFilesForExternalFileChange(store, target)
  ]).toEqual(
    getOpenFilesForExternalFileChange([...panel, ...store], { ...scope, relativePath: 'File.ts' })
  )
})
