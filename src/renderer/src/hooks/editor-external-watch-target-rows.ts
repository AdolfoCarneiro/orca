import type { AppState } from '@/store'
import { getIndexedWorktreesById } from '@/store/worktree-repo-index'
import { isWindowsAbsolutePathLike } from '../../../shared/cross-platform-path'
import {
  isLocalExecutionHost,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import {
  findIndexedWorktreeOwnerForHost,
  worktreeOwnerHostIds,
  resolveIndexedWorktreeOwner
} from '@/lib/worktree-runtime-owner-index'
import {
  createRepoRowExecutionHostLookup,
  resolveWorktreeExecutionHost
} from '../../../shared/worktree-execution-host-resolution'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import {
  resolveQualifiedIndexedFolderWorkspace,
  selectWorktreesByRepo
} from '@/store/workspace-record-selectors'

type WatchTargetRowState = Pick<
  AppState,
  'worktreesByRepo' | 'repos' | 'folderWorkspaces' | 'projectGroups'
>

export type EditorExternalWatchTargetRows = {
  worktree: AppState['worktreesByRepo'][string][number] | undefined
  repo: AppState['repos'][number] | undefined
  folderWorkspace: AppState['folderWorkspaces'][number] | undefined
  projectGroup: AppState['projectGroups'][number] | undefined
  connectionId: string | null | undefined
}

/** The catalog rows for one watch consumer, taken from the row on that consumer's own execution host. */
export function resolveEditorExternalWatchTargetRows(
  state: WatchTargetRowState,
  worktreeId: string,
  hostId: ExecutionHostId | null
): EditorExternalWatchTargetRows | null {
  const worktrees = selectWorktreesByRepo(state)
  const lookup = createRepoRowExecutionHostLookup(state.repos)
  const candidates = getIndexedWorktreesById(worktrees, worktreeId).flatMap((worktree) => {
    const indexedHost = worktreeOwnerHostIds(worktree)[0]
    if (findIndexedWorktreeOwnerForHost(worktrees, worktreeId, indexedHost) !== worktree) {
      return []
    }
    const owner = resolveWorktreeExecutionHost(lookup, worktree)
    if (owner.kind !== 'resolved') {
      return []
    }
    const matchesHost =
      !hostId ||
      (worktree.runtimeOwnerEnvironmentId?.trim()
        ? worktreeOwnerHostIds(worktree).includes(hostId)
        : owner.hostId === hostId)
    if (!matchesHost) {
      return []
    }
    const selectedOwner =
      hostId && hostId !== owner.hostId
        ? resolveWorktreeExecutionHost(lookup, { ...worktree, hostId })
        : owner
    return selectedOwner.kind === 'resolved' ? [{ worktree, owner: selectedOwner }] : []
  })
  const indexed = resolveIndexedWorktreeOwner(
    { candidates: candidates.map(({ worktree }) => worktree) },
    worktreeId
  )
  const selected =
    indexed.kind === 'resolved'
      ? candidates.find(({ worktree }) => worktree === indexed.owner)
      : undefined
  const worktree = selected?.worktree
  const workspaceScope = parseWorkspaceKey(worktreeId)
  const qualifiedFolder =
    workspaceScope?.type === 'folder'
      ? resolveQualifiedIndexedFolderWorkspace(
          state,
          workspaceScope.folderWorkspaceId,
          hostId ?? undefined
        )
      : null
  const selectedFolder = qualifiedFolder?.kind === 'selected' ? qualifiedFolder.value : null
  const folderWorkspace = selectedFolder?.workspace
  if (!worktree && !folderWorkspace) {
    return null
  }
  const worktreeOwner = selected?.owner
  const repo = worktreeOwner?.kind === 'resolved' ? (worktreeOwner.owner ?? undefined) : undefined
  const folderHost = parseExecutionHostId(
    selectedFolder?.hostId ?? folderWorkspace?.executionHostId
  )
  const projectGroup = folderWorkspace
    ? state.projectGroups.find(
        (group) =>
          group.id === folderWorkspace.projectGroupId &&
          parseExecutionHostId(group.executionHostId)?.id === folderHost?.id
      )
    : undefined
  const connectionId = selectedFolder
    ? selectedFolder.connectionId
    : worktreeOwner?.kind === 'resolved'
      ? worktreeOwner.connectionId
      : undefined
  return { worktree, repo, folderWorkspace, projectGroup, connectionId }
}

/** Only a proven-local Windows owner may match WSL alias paths for its watch root. */
export function canWatchLocalWindowsWslAliases(
  args: EditorExternalWatchTargetRows & {
    worktreePath: string
    runtimeEnvironmentId: string | null
  }
): boolean {
  if (
    args.runtimeEnvironmentId !== null ||
    args.connectionId !== null ||
    !isWindowsAbsolutePathLike(args.worktreePath)
  ) {
    return false
  }
  if (args.worktree) {
    return (
      !!args.repo &&
      !args.worktree.runtimeOwnerEnvironmentId?.trim() &&
      isLocalExecutionHost(args.worktree.hostId) &&
      isLocalExecutionHost(args.repo.executionHostId)
    )
  }
  return (
    !!args.folderWorkspace &&
    isLocalExecutionHost(args.folderWorkspace.executionHostId) &&
    isLocalExecutionHost(args.projectGroup?.executionHostId)
  )
}
