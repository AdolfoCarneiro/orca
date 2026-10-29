// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { attachEditorAutosaveController } from '@/components/editor/editor-autosave-controller'
import {
  createEditorStore,
  createFakeEditorDisk,
  withLoadedBaselines
} from '@/components/editor/editor-autosave-controller-test-fixture'
import {
  __clearSelfWriteRegistryForTests,
  getRecentSelfWrite,
  recordSelfWrite
} from '@/components/editor/editor-self-write-registry'
import {
  ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT,
  requestEditorFileSave
} from '@/components/editor/editor-autosave'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { useSourceControlEntryMutations } from '@/components/right-sidebar/source-control/commit/use-entry-mutations'
const mocks = vi.hoisted(() => ({ git: vi.fn() }))
vi.mock('@/lib/connection-context', () => ({
  getConnectionId: () => undefined,
  getConnectionIdForFile: () => undefined
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
  vi.resetAllMocks()
  __clearSelfWriteRegistryForTests()
})
afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    cleanup()
  }
  __clearSelfWriteRegistryForTests()
  vi.useRealTimers()
})
for (const route of ['single', 'bulk'] as const) {
  for (const mode of ['recent-dirty', 'expired-dirty', 'recent-clean'] as const) {
    it(`${route} ${mode} direct discard notification after a real autosave drain`, async () => {
      const disk = createFakeEditorDisk({ '/repo/a.ts': 'original' })
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
      const id = store.getState().openFile({
        filePath: '/repo/a.ts',
        relativePath: 'a.ts',
        worktreeId: 'wt-1',
        language: 'typescript',
        mode: 'edit'
      })
      withLoadedBaselines(store, disk)
      cleanups.push(attachEditorAutosaveController(store))
      let finishWrite: () => void = () => {
        throw new Error('write did not start')
      }
      disk.fs.writeFile.mockImplementationOnce(
        ({ filePath, content }: { filePath: string; content: string }) =>
          new Promise((resolve) => {
            finishWrite = () => {
              disk.files.set(filePath, content)
              resolve({ ok: true })
            }
          })
      )
      store.getState().setEditorDraft(id, 'autosave text')
      store.getState().markFileDirty(id, true)
      await vi.advanceTimersByTimeAsync(1000)
      expect(disk.fs.writeFile).toHaveBeenCalledTimes(1)
      expect(getRecentSelfWrite('/repo/a.ts')?.content).toBe('autosave text')
      let markGitStarted: () => void = () => {}
      const gitStarted = new Promise<void>((resolve) => {
        markGitStarted = resolve
      })
      let finishGit: () => void = () => {
        throw new Error('Git did not start')
      }
      mocks.git.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finishGit = () => {
              disk.files.set('/repo/a.ts', 'HEAD')
              resolve()
            }
            markGitStarted()
          })
      )
      const hook = renderHook(() =>
        useSourceControlEntryMutations({
          activeRepoTarget: { kind: 'local' },
          activeWorktreeId: 'wt-1',
          worktreePath: '/repo',
          refreshActiveGitStatusAfterMutation: async () => {}
        })
      )
      cleanups.push(hook.unmount)
      let notified = 0
      const listener = (): void => {
        notified++
      }
      window.addEventListener(ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT, listener)
      cleanups.push(() =>
        window.removeEventListener(ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT, listener)
      )
      const pending =
        route === 'single'
          ? hook.result.current.discardSingle('a.ts')
          : hook.result.current.discardMany(['a.ts'])
      await Promise.resolve()
      expect(mocks.git).not.toHaveBeenCalled()
      await act(async () => {
        finishWrite()
        await gitStarted
      })
      expect(mocks.git).toHaveBeenCalledTimes(1)
      expect(disk.files.get('/repo/a.ts')).toBe('autosave text')
      if (mode === 'expired-dirty') {
        await vi.advanceTimersByTimeAsync(751)
      }
      if (mode !== 'recent-clean') {
        store.getState().setEditorDraft(id, 'typed while Git pending')
        store.getState().markFileDirty(id, true)
      }
      const stampBeforeNotification = getRecentSelfWrite('/repo/a.ts')
      await act(async () => {
        finishGit()
        await pending
      })
      const after = store.getState().openFiles.find((file) => file.id === id)
      const snapshot = {
        route,
        mode,
        notified,
        stampBeforeNotification,
        diskAfterGit: disk.files.get('/repo/a.ts'),
        dirtyAfterNotification: after?.isDirty,
        externalMutationAfterNotification: after?.externalMutation ?? null,
        draftAfterNotification: store.getState().editorDrafts[id] ?? null
      }
      expect(notified).toBe(1)
      expect(snapshot.diskAfterGit).toBe('HEAD')
      if (mode === 'recent-dirty') {
        expect(snapshot.stampBeforeNotification?.content).toBe('autosave text')
        expect(snapshot.externalMutationAfterNotification).toBe('changed')
        expect(snapshot.dirtyAfterNotification).toBe(true)
        expect(snapshot.draftAfterNotification).toBe('typed while Git pending')
      }
      if (mode === 'expired-dirty') {
        expect(snapshot.stampBeforeNotification).toBe(null)
        expect(snapshot.externalMutationAfterNotification).toBe('changed')
        expect(snapshot.draftAfterNotification).toBe('typed while Git pending')
      }
      if (mode === 'recent-clean') {
        expect(snapshot.dirtyAfterNotification).toBe(false)
        expect(snapshot.draftAfterNotification).toBe(null)
      }
      await vi.advanceTimersByTimeAsync(1000)
      const final = {
        disk: disk.files.get('/repo/a.ts'),
        externalMutation:
          store.getState().openFiles.find((file) => file.id === id)?.externalMutation ?? null,
        writesAttempted: disk.fs.writeFile.mock.calls.length,
        draft: store.getState().editorDrafts[id] ?? null
      }
      expect(final.disk).toBe('HEAD')
      if (mode !== 'recent-clean') {
        expect(final.externalMutation).toBe('changed')
        expect(final.draft).toBe('typed while Git pending')
      }
      expect(final.writesAttempted).toBe(1)
    })
  }
}

for (const route of ['single', 'bulk'] as const) {
  for (const mode of ['newer-same-content', 'git-failure'] as const) {
    it(`${route} ${mode} retains valid stamps while Git is pending`, async () => {
      const disk = createFakeEditorDisk({ '/repo/a.ts': 'HEAD' })
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
      const id = store.getState().openFile({
        filePath: '/repo/a.ts',
        relativePath: 'a.ts',
        worktreeId: 'wt-1',
        language: 'typescript',
        mode: 'edit'
      })
      withLoadedBaselines(store, disk)
      cleanups.push(attachEditorAutosaveController(store))
      store.getState().setEditorDraft(id, 'same stamp content')
      store.getState().markFileDirty(id, true)
      await act(async () => {
        await requestEditorFileSave({ fileId: id })
      })
      expect(getRecentSelfWrite('/repo/a.ts')?.content).toBe('same stamp content')
      recordSelfWrite('/repo/unrelated.ts', 'unrelated content', 'env-other')
      let gitStarted: () => void = () => {}
      const started = new Promise<void>((resolve) => {
        gitStarted = resolve
      })
      let finishGitResponse: () => void = () => {
        throw new Error('Git not started')
      }
      mocks.git.mockImplementation(
        () =>
          new Promise<void>((resolve, reject) => {
            if (mode === 'newer-same-content') {
              disk.files.set('/repo/a.ts', 'HEAD')
            }
            finishGitResponse =
              mode === 'git-failure' ? () => reject(new Error('fixture Git failure')) : resolve
            gitStarted()
          })
      )
      const hook = renderHook(() =>
        useSourceControlEntryMutations({
          activeRepoTarget: { kind: 'local' },
          activeWorktreeId: 'wt-1',
          worktreePath: '/repo',
          refreshActiveGitStatusAfterMutation: async () => {}
        })
      )
      cleanups.push(hook.unmount)
      const notifications: string[] = []
      const listener = (): void => {
        notifications.push(getRecentSelfWrite('/repo/a.ts')?.content ?? 'absent')
      }
      window.addEventListener(ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT, listener)
      cleanups.push(() =>
        window.removeEventListener(ORCA_EDITOR_EXTERNAL_FILE_CHANGE_EVENT, listener)
      )
      const pending =
        route === 'single'
          ? hook.result.current.discardSingle('a.ts')
          : hook.result.current.discardMany(['a.ts', 'a.ts'])
      const observed = pending.then(
        () => 'success',
        () => 'failure'
      )
      await started
      if (mode === 'newer-same-content') {
        store.getState().setEditorDraft(id, 'same stamp content')
        store.getState().markFileDirty(id, true)
        await act(async () => {
          await requestEditorFileSave({ fileId: id, overwrite: true })
        })
        expect(disk.fs.writeFile).toHaveBeenCalledTimes(2)
        expect(disk.files.get('/repo/a.ts')).toBe('same stamp content')
        store.getState().setEditorDraft(id, 'typing after the newer same-content save')
        store.getState().markFileDirty(id, true)
      }
      await act(async () => {
        finishGitResponse()
        expect(await observed).toBe(mode === 'git-failure' ? 'failure' : 'success')
      })
      expect(getRecentSelfWrite('/repo/a.ts')?.content).toBe('same stamp content')
      expect(getRecentSelfWrite('/repo/unrelated.ts', 'env-other')?.content).toBe(
        'unrelated content'
      )
      expect(
        store.getState().openFiles.find((file) => file.id === id)?.externalMutation ?? null
      ).toBe(null)
      expect(notifications).toEqual(
        mode === 'git-failure' ? [] : Array(route === 'single' ? 1 : 2).fill('same stamp content')
      )
      if (mode === 'newer-same-content') {
        await vi.advanceTimersByTimeAsync(1000)
        expect(disk.files.get('/repo/a.ts')).toBe('typing after the newer same-content save')
        expect(disk.fs.writeFile).toHaveBeenCalledTimes(3)
      }
    })
  }
}
