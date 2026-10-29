import { useAppStore } from '@/store'
import { getRelativePathInsideRoot, joinPath } from '@/lib/path'
import type { DirEntry } from '../../../../shared/filesystem-entry-types'
import { sortDirEntries } from '../../../../shared/file-name-sort'
import { readRuntimeDirectory } from '@/runtime/runtime-file-mutation-client'
import type { DirCache, FileExplorerOperationOwner, TreeNode } from './file-explorer-types'
import { shouldIncludeFileExplorerEntry } from './file-explorer-entries'
import {
  parentDirForWatchPath,
  resolveCachedDirPath,
  createCachedDirPathIndex
} from './file-explorer-watch-path'
import {
  getFileExplorerOperationOwner,
  getFileExplorerOwnerUnresolvedMessage,
  getFileExplorerOperationRoute
} from './file-explorer-operation-owner'

export type FileExplorerDirectoryListing = {
  entries: DirEntry[]
  operationOwner: FileExplorerOperationOwner
}

export function fileExplorerEntriesToTreeNodes(
  entries: DirEntry[],
  dirPath: string,
  depth: number,
  worktreePath: string | null,
  operationOwner: FileExplorerOperationOwner
): TreeNode[] {
  return entries.filter(shouldIncludeFileExplorerEntry).map((entry) => {
    const path = joinPath(dirPath, entry.name)
    return {
      name: entry.name,
      path,
      relativePath: getRelativePathInsideRoot(path, worktreePath) ?? entry.name,
      isDirectory: entry.isDirectory,
      isSymlink: entry.isSymlink,
      depth: depth + 1,
      operationOwner
    }
  })
}

// Without followSymlinks, re-reading a parent lists opened folder links as files (#29069).
export function keepOpenedDirectoryLinks(
  previousChildren: readonly TreeNode[] | undefined,
  nextChildren: TreeNode[],
  dirCache: Readonly<Record<string, DirCache>>
): TreeNode[] {
  const openedLinks = new Map<string, string>()
  for (const child of previousChildren ?? []) {
    const cachedLink = dirCache[child.path]
    // Failed/pending reads and other-host listings do not prove a folder link was opened.
    if (
      child.isSymlink &&
      child.isDirectory &&
      child.operationOwner &&
      child.operationOwner.kind !== 'unresolved' &&
      cachedLink?.operationOwner &&
      cachedLink.error === undefined &&
      JSON.stringify(child.operationOwner) === JSON.stringify(cachedLink.operationOwner)
    ) {
      openedLinks.set(child.path, JSON.stringify(child.operationOwner))
    }
  }
  if (openedLinks.size === 0) {
    return nextChildren
  }
  return nextChildren.map((child) =>
    child.isSymlink &&
    !child.isDirectory &&
    child.operationOwner !== undefined &&
    openedLinks.get(child.path) === JSON.stringify(child.operationOwner)
      ? { ...child, isDirectory: true, isDirectoryFromOpenedLink: true }
      : child
  )
}

export function clearFailedOpenedDirectoryLinks(
  cache: Record<string, DirCache>,
  failedPaths: Iterable<string>
): Record<string, DirCache> {
  let index: ReadonlyMap<string, string> | undefined
  const parents = new Map<string, Set<string>>()
  for (const path of failedPaths) {
    const parent = resolveCachedDirPath(
      cache,
      parentDirForWatchPath(path),
      undefined,
      () => (index ??= createCachedDirPathIndex(cache))
    )
    if (!parent) {
      continue
    }
    let targets = parents.get(parent)
    if (!targets) {
      parents.set(parent, (targets = new Set()))
    }
    targets.add(path)
  }
  let next = cache
  for (const [path, targets] of parents) {
    const parent = cache[path]
    let children = parent.children
    for (let i = 0; i < parent.children.length; i++) {
      const child = parent.children[i]
      if (!targets.has(child.path) || !child.isSymlink || !child.isDirectoryFromOpenedLink) {
        continue
      }
      if (children === parent.children) {
        children = parent.children.slice()
      }
      children[i] = { ...child, isDirectory: false, isDirectoryFromOpenedLink: false }
    }
    if (children === parent.children) {
      continue
    }
    if (next === cache) {
      next = { ...cache }
    }
    next[path] = { ...parent, children }
  }
  return next
}

export async function readFileExplorerDirectory(
  activeWorktreeId: string | null | undefined,
  worktreePath: string | null,
  dirPath: string,
  options: { wakeWslDistro?: boolean } = {}
): Promise<FileExplorerDirectoryListing> {
  const operationOwner = getFileExplorerOperationOwner(activeWorktreeId)
  const route = getFileExplorerOperationRoute(operationOwner)
  if (!route) {
    throw new Error(getFileExplorerOwnerUnresolvedMessage())
  }
  const entries = await readRuntimeDirectory(
    {
      target: route.target,
      worktreeId: activeWorktreeId,
      worktreePath,
      connectionId: route.connectionId
    },
    dirPath,
    {
      ...(useAppStore.getState().settings?.followSymlinkedDirectories
        ? { followSymlinks: true }
        : {}),
      ...options
    }
  )
  // Older remote hosts may return lexical order; adaptive sorting keeps already-sorted local listings cheap.
  return {
    entries: sortDirEntries(entries),
    operationOwner
  }
}
