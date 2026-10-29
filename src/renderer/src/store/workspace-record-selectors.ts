import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { Worktree } from '../../../shared/worktree/types'
import type { HostWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { findIndexedWorktreeOwnerForHost } from '@/lib/worktree-runtime-owner-index'
import type { AppState } from './types'
import {
  folderWorkspaceMatchesHost,
  getFolderWorkspaceWorktree
} from './slices/worktrees/listing/detected-worktree-meta'

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

const folderRecordsById = new WeakMap<
  readonly FolderWorkspace[],
  ReadonlyMap<string, readonly FolderWorkspace[]>
>()

/** Directory readers preserve catalog order, including unqualified twin rows. */
export function findFolderWorkspaceRecord(
  folderWorkspaces: readonly FolderWorkspace[],
  folderWorkspaceId: string,
  hostId?: ExecutionHostId
): FolderWorkspace | undefined {
  let index = folderRecordsById.get(folderWorkspaces)
  if (!index) {
    const rows = new Map<string, FolderWorkspace[]>()
    for (const folder of folderWorkspaces) {
      const matches = rows.get(folder.id)
      if (matches) {
        matches.push(folder)
      } else {
        rows.set(folder.id, [folder])
      }
    }
    index = rows
    folderRecordsById.set(folderWorkspaces, index)
  }
  const matches = index.get(folderWorkspaceId)
  return hostId
    ? matches?.find((folder) => folderWorkspaceMatchesHost(folder, hostId))
    : matches?.[0]
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
    const folder = findFolderWorkspaceRecord(
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
