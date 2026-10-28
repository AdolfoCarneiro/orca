import type { Repo } from '../../../shared/repo-types'
import type { Worktree } from '../../../shared/worktree/types'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'

type WorktreeOwnerRecord = Pick<Worktree, 'id' | 'repoId' | 'hostId' | 'runtimeOwnerEnvironmentId'>
type DetectedWorktreeListing = { worktrees: readonly WorktreeOwnerRecord[] }
type RepoOwnerRecord = Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>
// Immutable-slice indexes avoid rescans on unrelated writes inside retained selectors and interaction paths.
const worktreeOwnerIndexCache = new WeakMap<
  Record<string, readonly WorktreeOwnerRecord[]>,
  ReadonlyMap<string, IndexedWorktreeOwnerEntry>
>()
const repoOwnerIndexCache = new WeakMap<
  readonly RepoOwnerRecord[],
  ReadonlyMap<string, IndexedRepoOwnerResolution>
>()
const detectedWorktreeIndexCache = new WeakMap<
  Record<string, DetectedWorktreeListing>,
  ReadonlyMap<string, readonly WorktreeOwnerRecord[]>
>()

const NO_DETECTED_WORKTREES: readonly WorktreeOwnerRecord[] = []

export function findIndexedWorktreeOwner(
  worktreesByRepo: Record<string, readonly WorktreeOwnerRecord[]> | undefined,
  worktreeId: string
): WorktreeOwnerRecord | null {
  const resolution = resolveIndexedWorktreeOwner(worktreesByRepo, worktreeId)
  return resolution.kind === 'resolved' ? resolution.owner : null
}

/** Returns the caller's own row type: the index records where the owner is listed. */
export function findIndexedWorktreeOwnerForHost<T extends WorktreeOwnerRecord>(
  worktreesByRepo: Record<string, readonly T[]> | undefined,
  worktreeId: string,
  executionHostId: ExecutionHostId
): T | null {
  const hostKey = `${worktreeId}\0${executionHostId}`
  resolveIndexedWorktreeOwner(worktreesByRepo, worktreeId)
  const entry = worktreesByRepo && worktreeOwnerIndexCache.get(worktreesByRepo)?.get(hostKey)
  const row = entry?.kind === 'resolved' ? worktreesByRepo?.[entry.bucket]?.[entry.position] : null
  return row ?? null
}

export type IndexedRepoOwnerResolution =
  | { kind: 'resolved'; owner: RepoOwnerRecord }
  | { kind: 'missing' }
  | { kind: 'ambiguous' }

function repoOwnerIdentity(owner: RepoOwnerRecord): string {
  return JSON.stringify([owner.executionHostId ?? null, owner.connectionId?.trim() || null])
}

export function resolveIndexedRepoOwner(
  repos: readonly RepoOwnerRecord[] | undefined,
  repoId: string
): IndexedRepoOwnerResolution {
  if (!repos) {
    return { kind: 'missing' }
  }
  let index = repoOwnerIndexCache.get(repos)
  if (!index) {
    const next = new Map<string, IndexedRepoOwnerResolution>()
    for (const repo of repos) {
      const repoId = repo.id
      const current = next.get(repoId)
      if (!current) {
        next.set(repoId, { kind: 'resolved', owner: repo })
      } else if (
        current.kind === 'resolved' &&
        repoOwnerIdentity(current.owner) !== repoOwnerIdentity(repo)
      ) {
        next.set(repoId, { kind: 'ambiguous' })
      }
      next.set(`${repoId}\0${getRepoExecutionHostId(repo)}`, {
        kind: 'resolved',
        owner: repo
      })
    }
    index = next
    repoOwnerIndexCache.set(repos, index)
  }
  return index.get(repoId) ?? { kind: 'missing' }
}

export type IndexedWorktreeOwnerResolution =
  | { kind: 'resolved'; owner: WorktreeOwnerRecord }
  | { kind: 'missing' }
  | { kind: 'ambiguous' }

// Where the owner is listed, so a typed caller reads its own row back without a cast.
type IndexedWorktreeOwnerEntry =
  | { kind: 'resolved'; owner: WorktreeOwnerRecord; bucket: string; position: number }
  | { kind: 'ambiguous' }

function worktreeOwnerIdentity(owner: WorktreeOwnerRecord): string {
  return JSON.stringify([
    owner.repoId,
    owner.hostId ?? null,
    owner.runtimeOwnerEnvironmentId?.trim() || null
  ])
}

function addWorktreeOwnerIndexEntry(
  index: Map<string, IndexedWorktreeOwnerEntry>,
  key: string,
  owner: WorktreeOwnerRecord,
  at: { bucket: string; position: number }
): void {
  const current = index.get(key)
  if (!current) {
    index.set(key, { kind: 'resolved', owner, ...at })
  } else if (
    current.kind === 'resolved' &&
    worktreeOwnerIdentity(current.owner) !== worktreeOwnerIdentity(owner)
  ) {
    index.set(key, { kind: 'ambiguous' })
  }
}

export function worktreeOwnerHostIds(owner: WorktreeOwnerRecord): ExecutionHostId[] {
  const physicalHostId = parseExecutionHostId(owner.hostId)?.id
  const runtimeEnvironmentId = owner.runtimeOwnerEnvironmentId?.trim()
  if (!runtimeEnvironmentId) {
    return [physicalHostId ?? 'local']
  }
  const runtimeHostId = toRuntimeExecutionHostId(runtimeEnvironmentId)
  // Why: paired HUB worktrees need logical-runtime lookup without losing their physical SSH route.
  return physicalHostId && physicalHostId !== runtimeHostId
    ? [physicalHostId, runtimeHostId]
    : [runtimeHostId]
}

export function resolveIndexedWorktreeOwner(
  worktreesByRepo: Record<string, readonly WorktreeOwnerRecord[]> | undefined,
  worktreeId: string
): IndexedWorktreeOwnerResolution {
  if (!worktreesByRepo) {
    return { kind: 'missing' }
  }
  let index = worktreeOwnerIndexCache.get(worktreesByRepo)
  if (!index) {
    const next = new Map<string, IndexedWorktreeOwnerEntry>()
    for (const [bucket, worktrees] of Object.entries(worktreesByRepo)) {
      worktrees.forEach((worktree, position) => {
        const id = worktree.id
        addWorktreeOwnerIndexEntry(next, id, worktree, { bucket, position })
        for (const hostId of worktreeOwnerHostIds(worktree)) {
          addWorktreeOwnerIndexEntry(next, `${id}\0${hostId}`, worktree, { bucket, position })
        }
      })
    }
    index = next
    worktreeOwnerIndexCache.set(worktreesByRepo, index)
  }
  return index.get(worktreeId) ?? { kind: 'missing' }
}

/**
 * Every detected publication of `worktreeId`, in catalog order. Rival repos may publish the same
 * id, so callers that fail closed on conflicts need all matches rather than one resolved owner.
 */
export function findIndexedDetectedWorktrees(
  detectedWorktreesByRepo: Record<string, DetectedWorktreeListing> | undefined,
  worktreeId: string
): readonly WorktreeOwnerRecord[] {
  if (!detectedWorktreesByRepo) {
    return NO_DETECTED_WORKTREES
  }
  let index = detectedWorktreeIndexCache.get(detectedWorktreesByRepo)
  if (!index) {
    const next = new Map<string, WorktreeOwnerRecord[]>()
    for (const listing of Object.values(detectedWorktreesByRepo)) {
      for (const worktree of listing.worktrees) {
        const matches = next.get(worktree.id)
        if (matches) {
          matches.push(worktree)
        } else {
          next.set(worktree.id, [worktree])
        }
      }
    }
    index = next
    detectedWorktreeIndexCache.set(detectedWorktreesByRepo, index)
  }
  return index.get(worktreeId) ?? NO_DETECTED_WORKTREES
}

export function hasIndexedDetectedWorktree(
  detectedWorktreesByRepo: Record<string, DetectedWorktreeListing> | undefined,
  worktreeId: string
): boolean {
  return findIndexedDetectedWorktrees(detectedWorktreesByRepo, worktreeId).length > 0
}

export function findIndexedRepoOwner(
  repos: readonly RepoOwnerRecord[] | undefined,
  repoId: string
): RepoOwnerRecord | null {
  const resolution = resolveIndexedRepoOwner(repos, repoId)
  return resolution.kind === 'resolved' ? resolution.owner : null
}

export function findIndexedRepoOwnerForHost<T extends RepoOwnerRecord>(
  repos: readonly T[] | undefined,
  repoId: string,
  executionHostId: ExecutionHostId
): T | null {
  if (!repos) {
    return null
  }
  resolveIndexedRepoOwner(repos, repoId)
  const resolution = repoOwnerIndexCache.get(repos)?.get(`${repoId}\0${executionHostId}`)
  // The cache is keyed by this exact array, so its owner retains the caller's row type.
  return resolution?.kind === 'resolved' ? (resolution.owner as T) : null
}

export {
  findFirstIndexedFolderWorkspace,
  findIndexedFolderWorkspaceOwner,
  findIndexedProjectGroupOwner,
  getCatalogOwnerHostId,
  resolveIndexedFolderWorkspaceOwner,
  resolveIndexedProjectGroupOwner
} from './workspace-catalog-owner-index'
