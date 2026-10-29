import type { Worktree } from '../../../shared/worktree/types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import {
  createRepoRowExecutionHostLookup,
  resolveWorktreeExecutionHost,
  type ExecutionHostOwnerLookup,
  type ExecutionHostOwnerRow
} from '../../../shared/worktree-execution-host-resolution'
import {
  findIndexedWorktreeOwnerForHost,
  resolveIndexedWorktreeOwner,
  worktreeOwnerHostIds
} from './worktree-runtime-owner-index'

type WorktreeOwnerRow = Pick<Worktree, 'id' | 'repoId' | 'hostId' | 'runtimeOwnerEnvironmentId'>

const EMPTY_REPOS: readonly ExecutionHostOwnerRow[] = []
const repoLookupCache = new WeakMap<
  readonly ExecutionHostOwnerRow[],
  ExecutionHostOwnerLookup<ExecutionHostOwnerRow>
>()

function repoExecutionHostLookup(repos: readonly ExecutionHostOwnerRow[]) {
  let lookup = repoLookupCache.get(repos)
  if (!lookup) {
    lookup = createRepoRowExecutionHostLookup(repos)
    repoLookupCache.set(repos, lookup)
  }
  return lookup
}

/** Qualify legacy repo proof without changing the raw index's absent-host compatibility rule. */
export function resolveQualifiedWorktreeExecutionOwner<W extends WorktreeOwnerRow>(
  worktreesByRepo: Record<string, readonly W[]> | undefined,
  repos: readonly ExecutionHostOwnerRow[] | undefined,
  worktreeId: string,
  hostId?: ExecutionHostId | null
) {
  const indexed = resolveIndexedWorktreeOwner(worktreesByRepo, worktreeId)
  const worktree =
    (hostId ? findIndexedWorktreeOwnerForHost(worktreesByRepo, worktreeId, hostId) : null) ??
    (indexed.kind === 'resolved'
      ? findIndexedWorktreeOwnerForHost(
          worktreesByRepo,
          worktreeId,
          worktreeOwnerHostIds(indexed.owner)[0]
        )
      : null)
  if (!worktree) {
    return null
  }
  const lookup = repoExecutionHostLookup(repos ?? EMPTY_REPOS)
  const owner = resolveWorktreeExecutionHost(lookup, {
    ...worktree,
    hostId: worktree.runtimeOwnerEnvironmentId?.trim()
      ? worktreeOwnerHostIds(worktree)[0]
      : worktree.hostId
  })
  if (
    owner.kind !== 'resolved' ||
    (hostId &&
      (worktree.runtimeOwnerEnvironmentId?.trim()
        ? !worktreeOwnerHostIds(worktree).includes(hostId)
        : owner.hostId !== hostId))
  ) {
    return null
  }
  const selectedOwner =
    hostId && hostId !== owner.hostId
      ? resolveWorktreeExecutionHost(lookup, { ...worktree, hostId })
      : owner
  return selectedOwner.kind === 'resolved' ? { ...selectedOwner, worktree } : null
}
