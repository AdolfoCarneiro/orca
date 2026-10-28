import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../shared/project-group-types'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'

type FolderWorkspaceOwnerRecord = Pick<
  FolderWorkspace,
  'id' | 'projectGroupId' | 'connectionId' | 'executionHostId' | 'diffComments'
>
type ProjectGroupOwnerRecord = Pick<ProjectGroup, 'id' | 'connectionId' | 'executionHostId'>
type CatalogOwnerResolution<T> = { kind: 'resolved'; owner: T } | { kind: 'ambiguous' }
type IndexedCatalogOwnerEntry<T> = {
  resolution: CatalogOwnerResolution<T>
  firstPosition: number
}

const folderWorkspaceOwnerIndexCache = new WeakMap<
  readonly FolderWorkspaceOwnerRecord[],
  ReadonlyMap<string, IndexedCatalogOwnerEntry<FolderWorkspaceOwnerRecord>>
>()
const projectGroupOwnerIndexCache = new WeakMap<
  readonly ProjectGroupOwnerRecord[],
  ReadonlyMap<string, IndexedCatalogOwnerEntry<ProjectGroupOwnerRecord>>
>()
type IndexedFolderWorkspaceOwnerResolution =
  | { kind: 'resolved'; owner: FolderWorkspaceOwnerRecord }
  | { kind: 'missing' }
  | { kind: 'ambiguous' }

type IndexedProjectGroupOwnerResolution =
  | { kind: 'resolved'; owner: ProjectGroupOwnerRecord }
  | { kind: 'missing' }
  | { kind: 'ambiguous' }

export function getCatalogOwnerHostId(owner: {
  connectionId?: string | null
  executionHostId?: string | null
}): ExecutionHostId {
  return getRepoExecutionHostId(owner)
}

function buildCatalogOwnerIndex<
  T extends { id: string; connectionId?: string | null; executionHostId?: string | null }
>(records: readonly T[]): ReadonlyMap<string, IndexedCatalogOwnerEntry<T>> {
  const next = new Map<string, IndexedCatalogOwnerEntry<T>>()
  for (const [position, record] of records.entries()) {
    const id = record.id
    const hostId = getCatalogOwnerHostId(record)
    const hostKey = `${id}\0${hostId}`
    const current = next.get(id)
    const entry: IndexedCatalogOwnerEntry<T> = {
      resolution: { kind: 'resolved', owner: record },
      firstPosition: next.get(hostKey)?.firstPosition ?? position
    }
    if (!current) {
      next.set(id, entry)
    } else if (
      current.resolution.kind === 'resolved' &&
      getCatalogOwnerHostId(current.resolution.owner) !== hostId
    ) {
      next.set(id, {
        resolution: { kind: 'ambiguous' },
        firstPosition: current.firstPosition
      })
    }
    next.set(hostKey, entry)
  }
  return next
}

function catalogOwnerKey(id: string, executionHostId?: ExecutionHostId): string {
  return executionHostId ? `${id}\0${executionHostId}` : id
}

function getFolderWorkspaceOwnerIndex(folderWorkspaces: readonly FolderWorkspaceOwnerRecord[]) {
  let index = folderWorkspaceOwnerIndexCache.get(folderWorkspaces)
  if (!index) {
    index = buildCatalogOwnerIndex(folderWorkspaces)
    folderWorkspaceOwnerIndexCache.set(folderWorkspaces, index)
  }
  return index
}

/** An unqualified lookup keeps a twin (same id on two hosts) distinct from a missing row. */
export function resolveIndexedFolderWorkspaceOwner(
  folderWorkspaces: readonly FolderWorkspaceOwnerRecord[] | undefined,
  folderWorkspaceId: string,
  executionHostId?: ExecutionHostId
): IndexedFolderWorkspaceOwnerResolution {
  if (!folderWorkspaces) {
    return { kind: 'missing' }
  }
  const index = getFolderWorkspaceOwnerIndex(folderWorkspaces)
  return (
    index.get(catalogOwnerKey(folderWorkspaceId, executionHostId))?.resolution ?? {
      kind: 'missing'
    }
  )
}

/** UI catalog readers retain the first matching row even when owner resolution is ambiguous. */
export function findFirstIndexedFolderWorkspace<T extends FolderWorkspaceOwnerRecord>(
  folderWorkspaces: readonly T[] | undefined,
  folderWorkspaceId: string,
  executionHostId?: ExecutionHostId
): T | undefined {
  if (!folderWorkspaces) {
    return undefined
  }
  const entry = getFolderWorkspaceOwnerIndex(folderWorkspaces).get(
    catalogOwnerKey(folderWorkspaceId, executionHostId)
  )
  return entry ? folderWorkspaces[entry.firstPosition] : undefined
}

/** An unqualified lookup keeps a twin (same id on two hosts) distinct from a missing row. */
export function resolveIndexedProjectGroupOwner(
  projectGroups: readonly ProjectGroupOwnerRecord[] | undefined,
  projectGroupId: string,
  executionHostId?: ExecutionHostId
): IndexedProjectGroupOwnerResolution {
  if (!projectGroups) {
    return { kind: 'missing' }
  }
  let index = projectGroupOwnerIndexCache.get(projectGroups)
  if (!index) {
    index = buildCatalogOwnerIndex(projectGroups)
    projectGroupOwnerIndexCache.set(projectGroups, index)
  }
  return (
    index.get(catalogOwnerKey(projectGroupId, executionHostId))?.resolution ?? { kind: 'missing' }
  )
}

export function findIndexedFolderWorkspaceOwner<T extends FolderWorkspaceOwnerRecord>(
  folderWorkspaces: readonly T[] | undefined,
  folderWorkspaceId: string,
  executionHostId?: ExecutionHostId
): T | null {
  const resolution = resolveIndexedFolderWorkspaceOwner(
    folderWorkspaces,
    folderWorkspaceId,
    executionHostId
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the index is built from and cached on this exact array, so its owner is one of the caller's T rows.
  return resolution.kind === 'resolved' ? (resolution.owner as T) : null
}

export function findIndexedProjectGroupOwner<T extends ProjectGroupOwnerRecord>(
  projectGroups: readonly T[] | undefined,
  projectGroupId: string,
  executionHostId?: ExecutionHostId
): T | null {
  const resolution = resolveIndexedProjectGroupOwner(projectGroups, projectGroupId, executionHostId)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the index is built from and cached on this exact array, so its owner is one of the caller's T rows.
  return resolution.kind === 'resolved' ? (resolution.owner as T) : null
}
