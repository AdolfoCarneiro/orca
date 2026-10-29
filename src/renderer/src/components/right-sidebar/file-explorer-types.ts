import type { Dispatch, SetStateAction } from 'react'
import type { UserOpenedPathStat } from '@/lib/user-opened-local-path'
import type { ExecutionHostId } from '../../../../shared/execution-host'

export type FileExplorerOperationOwner =
  | { kind: 'local' }
  | { kind: 'ssh'; connectionId: string }
  | { kind: 'runtime'; environmentId: string; executionHostId: ExecutionHostId }
  | { kind: 'unresolved' }

export type TreeNode = {
  name: string
  path: string
  relativePath: string
  isDirectory: boolean
  isSymlink?: boolean
  /** Inferred from an opened link, not the parent's latest host listing. */
  isDirectoryFromOpenedLink?: boolean
  depth: number
  /** Host snapshot that produced this node. Destructive actions fail closed without it. */
  operationOwner?: FileExplorerOperationOwner
}

/** Keep loading outside dirCache to avoid rebuilding the tree; see file-explorer-dir-load-state.ts. */
export type DirCache = {
  error?: string
  children: TreeNode[]
  operationOwner?: FileExplorerOperationOwner
}

/** Retry covered dir reads after supersession, but not unreadable roots, which would add one dead transport timeout per dir. */
export type FileExplorerTreeRefreshOutcome = 'refreshed' | 'superseded' | 'root-unreadable'

export type FileExplorerDirectoryReadOptions = {
  force?: boolean
  failOnError?: boolean
  wakeWslDistro?: boolean
}

export type FileExplorerRevealOrigin = 'manual' | 'active-file'
export type FileExplorerRevealObservation = (
  path: string,
  depth: number,
  origin: FileExplorerRevealOrigin,
  isCurrent: () => boolean
) => Promise<FileExplorerTreeRefreshOutcome>

export type FileExplorerRevealAuthority = (
  paths: readonly string[],
  renderedCache: Readonly<Record<string, DirCache>>
) => 'pending' | 'terminal' | 'ready'

export type UseFileExplorerTreeResult = {
  getRevealAuthority: FileExplorerRevealAuthority
  observeDirForReveal: FileExplorerRevealObservation
  dirCache: Record<string, DirCache>
  setDirCache: Dispatch<SetStateAction<Record<string, DirCache>>>
  /** Workspace whose committed root listing owns the rendered cache. */
  sourceWorkspaceId: string | null
  /** Dirs with a read in flight — kept out of dirCache so the row projection does not rebuild. */
  loadingDirPaths: ReadonlySet<string>
  rootCache: DirCache | undefined
  rootError: string | null
  loadDir: (
    dirPath: string,
    depth: number,
    options?: FileExplorerDirectoryReadOptions
  ) => Promise<boolean>
  statPath: (path: string) => Promise<UserOpenedPathStat>
  markPathAsDirectory: (path: string) => void
  refreshTree: () => Promise<FileExplorerTreeRefreshOutcome>
  /** `wakeWslDistro` only for a user act: it may start a stopped WSL distro. */
  refreshDir: (dirPath: string, options?: { wakeWslDistro?: boolean }) => Promise<void>
  /** True while a cached listing still needs verification after invalidation. */
  isDirStale: (dirPath: string) => boolean
  invalidateTree: () => void
  retireView: () => void
  requestDir: (dirPath: string) => void
  reconcileView: (
    requiredDirs: Set<string>,
    canCommit: () => boolean,
    viewError: string | null,
    displayRootPath?: string | null
  ) => void
  loadRevision: number
  resetAndLoad: (options?: { wakeWslDistro?: boolean }) => void
}
