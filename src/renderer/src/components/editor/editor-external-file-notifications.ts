import { joinPath } from '@/lib/path'
import { isLocalWindowsDesktopClient } from '@/lib/desktop-window-chrome'
import type { OpenFile } from '@/store/slices/editor'
import { notifyEditorExternalFileChange, type EditorPathMutationTarget } from './editor-autosave'
import { EditorOpenFilePathIndex, editorPathIdentity } from './editor-open-file-path-index'

type NotificationScope = Omit<EditorPathMutationTarget, 'relativePath' | 'indexedOpenFiles'>

export function notifyEditorExternalFileChanges(
  scope: NotificationScope,
  relativePaths: readonly string[]
): void {
  const allowAliases = scope.allowLocalWindowsWslAliases === true && isLocalWindowsDesktopClient()
  const indexedScope = {
    ...scope,
    ...(Object.hasOwn(scope, 'runtimeEnvironmentId')
      ? { runtimeEnvironmentId: scope.runtimeEnvironmentId?.trim() || null }
      : {})
  }
  const lookups = new WeakMap<OpenFile[], EditorOpenFilePathIndex>()
  for (const relativePath of relativePaths) {
    const absolutePath = joinPath(scope.worktreePath, relativePath)
    const change = {
      absolutePath,
      relativePath,
      identity: editorPathIdentity(absolutePath, allowAliases)
    }
    const target = { ...scope, relativePath }
    Object.defineProperty(target, 'indexedOpenFiles', {
      value: {
        matches: (current: OpenFile[]) => {
          let lookup = lookups.get(current)
          if (!lookup) {
            lookup = new EditorOpenFilePathIndex(current, indexedScope, allowAliases)
            lookups.set(current, lookup)
          }
          return lookup.matchingOpenFiles(change)
        }
      }
    })
    notifyEditorExternalFileChange(target)
  }
}
