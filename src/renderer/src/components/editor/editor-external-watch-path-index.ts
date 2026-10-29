import { joinPath } from '@/lib/path'
import { getExternalFileChangeRelativePath } from '@/components/right-sidebar/useFileExplorerWatch'
import type { OpenFile } from '@/store/slices/editor'
import type { FsChangedPayload } from '../../../../shared/filesystem-entry-types'
import {
  EditorOpenFilePathIndex,
  editorPathIdentity,
  type IndexedEditorPath,
  type IndexedEditorFileChange
} from './editor-open-file-path-index'
import type { LocalWindowsWslPathIdentity } from '../../../../shared/cross-platform-path'

type WatchScope = {
  worktreeId: string
  worktreePath: string
  runtimeEnvironmentId: string | null
  allowLocalWindowsWslAliases?: true
}

export type IndexedExternalWatchChange = IndexedEditorFileChange

export type EditorExternalWatchBatchPathIndex = {
  createOrUpdatePaths: ReadonlyMap<string, string>
  changes: readonly IndexedExternalWatchChange[]
  deletedOpenEditors: readonly { file: OpenFile; normalizedDeletePath: string }[]
  hasCombinedDiffConsumer: boolean
  matchesCreateOrUpdate: (file: OpenFile) => boolean
  matchingOpenFiles: (
    change: IndexedExternalWatchChange,
    currentOpenFiles?: OpenFile[]
  ) => OpenFile[]
}

class IndexedEditorPathLookup<T> {
  private readonly direct = new Map<string, T>()
  private readonly aliases = new Map<string, T>()
  private readonly wslAliases = new Map<string, T>()

  constructor(private readonly allowAliases: boolean) {}

  add(path: IndexedEditorPath, value: T): void {
    this.direct.set(path.identity.normalizedPath, value)
    if (!this.allowAliases) {
      return
    }
    this.aliases.set(path.identity.aliasComparisonPath, value)
    if (path.identity.isWslUnc) {
      this.wslAliases.set(path.identity.aliasComparisonPath, value)
    }
  }

  get(identity: LocalWindowsWslPathIdentity): T | undefined {
    const direct = this.direct.get(identity.normalizedPath)
    if (direct !== undefined || !this.allowAliases) {
      return direct
    }
    return identity.isWslUnc
      ? this.aliases.get(identity.aliasComparisonPath)
      : this.wslAliases.get(identity.aliasComparisonPath)
  }
}

export function indexEditorExternalWatchBatchPaths(
  payload: FsChangedPayload,
  openFiles: OpenFile[],
  scope: WatchScope
): EditorExternalWatchBatchPathIndex {
  const allowAliases = scope.allowLocalWindowsWslAliases === true
  const createOrUpdateLookup = new IndexedEditorPathLookup<IndexedEditorPath>(allowAliases)
  const deleteLookup = new IndexedEditorPathLookup<IndexedEditorPath>(allowAliases)
  const createOrUpdatePaths = new Map<string, string>()
  const changesByRelativePath = new Map<string, IndexedExternalWatchChange>()

  for (const event of payload.events) {
    if (event.kind === 'overflow') {
      continue
    }
    const eventPath: IndexedEditorPath = {
      absolutePath: event.absolutePath,
      identity: editorPathIdentity(event.absolutePath, allowAliases)
    }
    if (event.kind === 'delete') {
      deleteLookup.add(eventPath, eventPath)
      continue
    }
    if (event.isDirectory !== true) {
      createOrUpdatePaths.set(eventPath.identity.normalizedPath, event.absolutePath)
      createOrUpdateLookup.add(eventPath, eventPath)
    }
    const relativePath = getExternalFileChangeRelativePath(
      scope.worktreePath,
      event.absolutePath,
      event.isDirectory
    )
    if (relativePath && !changesByRelativePath.has(relativePath)) {
      const absolutePath = joinPath(scope.worktreePath, relativePath)
      changesByRelativePath.set(relativePath, {
        relativePath,
        absolutePath,
        identity: eventPath.identity
      })
    }
  }

  const initialOpenFileLookup = new EditorOpenFilePathIndex(openFiles, scope, allowAliases)
  const openFileLookups = new WeakMap<OpenFile[], EditorOpenFilePathIndex>()
  openFileLookups.set(openFiles, initialOpenFileLookup)
  const getOpenFileLookup = (currentOpenFiles: OpenFile[]): EditorOpenFilePathIndex => {
    const existing = openFileLookups.get(currentOpenFiles)
    if (existing) {
      return existing
    }
    const indexed = new EditorOpenFilePathIndex(currentOpenFiles, scope, allowAliases)
    openFileLookups.set(currentOpenFiles, indexed)
    return indexed
  }
  const matchesCreateOrUpdate = (file: OpenFile): boolean => {
    const identity =
      initialOpenFileLookup.indexedOpenFiles.get(file.id)?.identity ??
      editorPathIdentity(file.filePath, allowAliases)
    return createOrUpdateLookup.get(identity) !== undefined
  }
  const deletedOpenEditors: { file: OpenFile; normalizedDeletePath: string }[] = []
  for (const indexedFile of initialOpenFileLookup.indexedOpenFiles.values()) {
    const deletedPath = deleteLookup.get(indexedFile.identity)
    if (deletedPath) {
      deletedOpenEditors.push({
        file: indexedFile.file,
        normalizedDeletePath: deletedPath.identity.normalizedPath
      })
    }
  }

  return {
    createOrUpdatePaths,
    changes: [...changesByRelativePath.values()],
    deletedOpenEditors,
    hasCombinedDiffConsumer: initialOpenFileLookup.hasCombinedDiffConsumer,
    matchesCreateOrUpdate,
    matchingOpenFiles: (change, currentOpenFiles = openFiles) =>
      getOpenFileLookup(currentOpenFiles).matchingOpenFiles(change)
  }
}
