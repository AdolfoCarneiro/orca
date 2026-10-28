import type { Worktree } from '../../../shared/worktree/types'
import type { HostWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import {
  findFirstIndexedFolderWorkspace,
  findIndexedWorktreeOwnerForHost
} from '@/lib/worktree-runtime-owner-index'
import type { AppState } from './types'
import { getFolderWorkspaceWorktree } from './slices/worktrees/listing/detected-worktree-meta'

// Route workspace readers here; check-workspace-record-read-ratchet.mjs enforces this boundary.

export type WorkspaceRecordState = Pick<AppState, 'worktreesByRepo' | 'folderWorkspaces'>

/** Git worktrees per repo id, in listing order. */
export function selectWorktreesByRepo<TState extends { worktreesByRepo?: unknown }>(
  state: TState
): TState['worktreesByRepo'] {
  return state.worktreesByRepo
}

export function selectFolderWorkspaces<TState extends { folderWorkspaces?: unknown }>(
  state: TState
): TState['folderWorkspaces'] {
  return state.folderWorkspaces
}

/** Checkouts git reports that Orca does not track, per repo id. */
export function selectDetectedWorktreesByRepo<TState extends { detectedWorktreesByRepo?: unknown }>(
  state: TState
): TState['detectedWorktreesByRepo'] {
  return state.detectedWorktreesByRepo
}

/**
 * The row that owns `target` on its host, including a paired runtime's logical host alias.
 * An ambiguous owner on that host answers undefined.
 */
export function selectWorkspaceByHostTarget(
  state: WorkspaceRecordState,
  target: HostWorktreeTarget
): Worktree | undefined {
  const scope = parseWorkspaceKey(target.id)
  if (scope?.type === 'folder') {
    const folder = findFirstIndexedFolderWorkspace(
      state.folderWorkspaces,
      scope.folderWorkspaceId,
      target.hostId
    )
    return folder ? getFolderWorkspaceWorktree(folder) : undefined
  }
  return (
    findIndexedWorktreeOwnerForHost(state.worktreesByRepo, target.id, target.hostId) ?? undefined
  )
}
