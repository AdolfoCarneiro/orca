import type { OpenFile } from '@/store/slices/editor'
import { externalChangePathKeyFor } from '@/store/slices/editor/buffers/editor-buffer-identity'
import {
  getLocalWindowsWslPathIdentity,
  normalizeRuntimePathForComparison,
  type LocalWindowsWslPathIdentity
} from '../../../../shared/cross-platform-path'

export type EditorOpenFilePathScope = {
  worktreeId: string
  worktreePath: string
  runtimeEnvironmentId?: string | null
}

export type IndexedEditorPath = {
  absolutePath: string
  identity: LocalWindowsWslPathIdentity
}

export type IndexedEditorFileChange = IndexedEditorPath & {
  relativePath: string
}

type IndexedOpenFile = {
  file: OpenFile
  index: number
}

type IndexedOpenEditorFile = IndexedOpenFile & {
  identity: LocalWindowsWslPathIdentity
}

function openFileRuntimeOwner(file: Pick<OpenFile, 'runtimeEnvironmentId'>): string | null {
  return file.runtimeEnvironmentId?.trim() || null
}

function addToListMap<T>(map: Map<string, T[]>, key: string, value: T): void {
  const existing = map.get(key)
  if (existing) {
    existing.push(value)
  } else {
    map.set(key, [value])
  }
}

export function editorPathIdentity(
  value: string,
  allowAliases: boolean
): LocalWindowsWslPathIdentity {
  if (allowAliases) {
    return getLocalWindowsWslPathIdentity(value)
  }
  const normalizedPath = normalizeRuntimePathForComparison(value)
  return { normalizedPath, aliasComparisonPath: normalizedPath, isWslUnc: false }
}

function collectMatchingFiles(
  direct: readonly IndexedOpenFile[],
  aliases: readonly IndexedOpenFile[],
  diffs: readonly IndexedOpenFile[]
): OpenFile[] {
  const byIndex = new Map<number, OpenFile>()
  for (const entry of [...direct, ...aliases, ...diffs]) {
    byIndex.set(entry.index, entry.file)
  }
  return [...byIndex.entries()].sort(([left], [right]) => left - right).map(([, file]) => file)
}

export class EditorOpenFilePathIndex {
  private readonly directEditors = new Map<string, IndexedOpenFile[]>()
  private readonly aliasEditors = new Map<string, IndexedOpenFile[]>()
  private readonly wslAliasEditors = new Map<string, IndexedOpenFile[]>()
  private readonly diffsByRelativePath = new Map<string, IndexedOpenFile[]>()
  readonly indexedOpenFiles = new Map<string, IndexedOpenEditorFile>()
  readonly hasCombinedDiffConsumer: boolean

  private readonly directKey: (filePath: string) => string

  constructor(
    openFiles: readonly OpenFile[],
    scope: EditorOpenFilePathScope,
    private readonly allowAliases: boolean
  ) {
    this.directKey = externalChangePathKeyFor(scope.worktreePath)
    let hasCombinedDiffConsumer = false
    for (const [index, file] of openFiles.entries()) {
      if (
        file.worktreeId !== scope.worktreeId ||
        (Object.hasOwn(scope, 'runtimeEnvironmentId') &&
          openFileRuntimeOwner(file) !== (scope.runtimeEnvironmentId ?? null))
      ) {
        continue
      }
      if (
        file.mode === 'diff' &&
        (file.diffSource === 'combined-uncommitted' || file.diffSource === 'combined-all')
      ) {
        hasCombinedDiffConsumer = true
        continue
      }
      if (file.mode === 'diff') {
        if (file.diffSource === 'unstaged' || file.diffSource === 'staged') {
          addToListMap(this.diffsByRelativePath, file.relativePath, {
            file,
            index
          })
        }
        continue
      }
      if (file.mode !== 'edit' && file.mode !== 'markdown-preview') {
        continue
      }
      const identity = editorPathIdentity(file.filePath, allowAliases)
      const indexedFile = { file, index, identity }
      this.indexedOpenFiles.set(file.id, indexedFile)
      addToListMap(this.directEditors, this.directKey(file.filePath), indexedFile)
      if (allowAliases) {
        addToListMap(this.aliasEditors, identity.aliasComparisonPath, indexedFile)
        if (identity.isWslUnc) {
          addToListMap(this.wslAliasEditors, identity.aliasComparisonPath, indexedFile)
        }
      }
    }
    this.hasCombinedDiffConsumer = hasCombinedDiffConsumer
  }

  matchingOpenFiles(change: IndexedEditorFileChange): OpenFile[] {
    const aliases = !this.allowAliases
      ? []
      : change.identity.isWslUnc
        ? (this.aliasEditors.get(change.identity.aliasComparisonPath) ?? [])
        : (this.wslAliasEditors.get(change.identity.aliasComparisonPath) ?? [])
    return collectMatchingFiles(
      this.directEditors.get(this.directKey(change.absolutePath)) ?? [],
      aliases,
      this.diffsByRelativePath.get(change.relativePath) ?? []
    )
  }
}
