import {
  LOCAL_EXECUTION_HOST_ID,
  getRepoExecutionHostId,
  parseExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { folderWorkspaceKey, parseWorkspaceKey } from '../../../shared/workspace-scope'
import {
  findIndexedFolderWorkspaceOwner,
  findIndexedProjectGroupOwner,
  findIndexedRepoOwner,
  findIndexedRepoOwnerForHost,
  findIndexedWorktreeOwner,
  findIndexedWorktreeOwnerForHost
} from './worktree-runtime-owner-index'
import type { WorktreeRuntimeOwnerState } from './worktree-runtime-owner-state'
import { runtimeRpcTargetForAuthorityKey } from '@/runtime/runtime-client-target'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'

export function getResolvedFolderExecutionOwner<
  T extends NonNullable<WorktreeRuntimeOwnerState['folderWorkspaces']>[number]
>(
  state: WorktreeRuntimeOwnerState & { folderWorkspaces?: readonly T[] },
  folderWorkspaceId: string
): { hostId: ExecutionHostId; workspace: T } | null {
  const preferredHostId =
    state.activeWorktreeId === folderWorkspaceKey(folderWorkspaceId)
      ? (state.activeWorkspaceExecutionHostId ?? undefined)
      : undefined
  const folderWorkspaces = state.folderWorkspaces
  const folder =
    findIndexedFolderWorkspaceOwner(folderWorkspaces, folderWorkspaceId, preferredHostId) ??
    findIndexedFolderWorkspaceOwner(folderWorkspaces, folderWorkspaceId)
  if (!folder) {
    return null
  }
  const group = folder
    ? (findIndexedProjectGroupOwner(state.projectGroups, folder.projectGroupId, preferredHostId) ??
      findIndexedProjectGroupOwner(state.projectGroups, folder.projectGroupId))
    : null
  const explicitHost = parseExecutionHostId(folder?.executionHostId ?? group?.executionHostId)
  const connectionId = folder.connectionId?.trim() || group?.connectionId?.trim()
  const restoredHost = parseExecutionHostId(
    state.restoredRuntimeHostIdByWorkspaceSessionKey?.[folderWorkspaceKey(folderWorkspaceId)]
  )
  const hostId =
    explicitHost?.id ??
    (connectionId
      ? toSshExecutionHostId(connectionId)
      : restoredHost?.kind === 'runtime'
        ? restoredHost.id
        : group || preferredHostId
          ? (preferredHostId ?? LOCAL_EXECUTION_HOST_ID)
          : null)
  return hostId && (!preferredHostId || hostId === preferredHostId)
    ? { hostId, workspace: folder }
    : null
}

/** Keep the selected row and inherited host together through runtime/path resolution. */
export function getResolvedWorktreeExecutionOwner<
  T extends NonNullable<WorktreeRuntimeOwnerState['worktreesByRepo']>[string][number]
>(
  state: WorktreeRuntimeOwnerState & { worktreesByRepo?: Record<string, readonly T[]> },
  worktreeId: string
): { hostId: ExecutionHostId; workspace: T } | null {
  const preferredHostId =
    state.activeWorktreeId === worktreeId
      ? (state.activeWorkspaceExecutionHostId ?? undefined)
      : undefined
  const qualifiedWorktree = preferredHostId
    ? findIndexedWorktreeOwnerForHost(state.worktreesByRepo, worktreeId, preferredHostId)
    : null
  const physicalOwner = parseExecutionHostId(qualifiedWorktree?.hostId)
  if (qualifiedWorktree && physicalOwner) {
    return { hostId: physicalOwner.id, workspace: qualifiedWorktree }
  }
  const worktree = qualifiedWorktree ?? findIndexedWorktreeOwner(state.worktreesByRepo, worktreeId)
  if (!worktree) {
    return null
  }
  const repo =
    (preferredHostId
      ? findIndexedRepoOwnerForHost(state.repos, worktree.repoId, preferredHostId)
      : null) ?? findIndexedRepoOwner(state.repos, worktree.repoId)
  const hostId =
    parseExecutionHostId(worktree.hostId)?.id ?? (repo ? getRepoExecutionHostId(repo) : null)
  return hostId && (!preferredHostId || hostId === preferredHostId)
    ? { hostId, workspace: worktree }
    : null
}

function restoredFolderRuntimeHost(
  state: WorktreeRuntimeOwnerState,
  key: string
): ExecutionHostId | null {
  const host = parseExecutionHostId(state.restoredRuntimeHostIdByWorkspaceSessionKey?.[key])
  return host?.kind === 'runtime' ? host.id : null
}

/** Require hydrated ownership: restored SSH worktrees can collide with local repo rows while catalogs load. */
export function getResolvedExecutionHostIdForWorktree(
  state: WorktreeRuntimeOwnerState,
  worktreeId: string | null | undefined
): ExecutionHostId | null {
  if (!worktreeId) {
    return null
  }
  if (worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
    return LOCAL_EXECUTION_HOST_ID
  }
  const scope = parseWorkspaceKey(worktreeId)
  return scope?.type === 'folder'
    ? (getResolvedFolderExecutionOwner(state, scope.folderWorkspaceId)?.hostId ??
        restoredFolderRuntimeHost(state, folderWorkspaceKey(scope.folderWorkspaceId)))
    : (getResolvedWorktreeExecutionOwner(state, worktreeId)?.hostId ?? null)
}

/**
 * RPC target of the focused workspace's owner row; `null` when nothing is focused, ownership is
 * unproven, or the owner has no RPC route (direct SSH). Callers pick their own fallback.
 */
export function getActiveWorkspaceOwnerTarget(
  state: WorktreeRuntimeOwnerState
): RuntimeClientTarget | null {
  // Without paired servers all RPC owners are this app; skip building the owner index.
  if (state.runtimeEnvironmentCatalogHydrated && state.runtimeEnvironments?.length === 0) {
    return null
  }
  const hostId = getResolvedExecutionHostIdForWorktree(state, state.activeWorktreeId)
  return hostId ? runtimeRpcTargetForAuthorityKey(hostId) : null
}
