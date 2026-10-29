import { isFloatingWorkspaceId } from '../../../../shared/floating-workspace-worktree'
import { isWorkspaceKey, worktreeWorkspaceKey } from '../../../../shared/workspace-scope'
import { appendHistoryEntry } from '../../store/slices/worktree-nav-history'
import { tabActivationPatch } from '../../store/slices/tabs/tabs-focus-actions'
import { deriveActiveSurfaceForWorktree } from '../../store/slices/tabs/tabs-surface'
import { executionHostIdForSessionTabsOwner } from '../local-structured-session-owner'
import type { SnapshotOpenPlacement } from './open-placement'
import type { WebSessionTabsSyncState } from './state'
import { snapshotOpenSelectionRecords } from './store-patch'

/** Membership and original-view admission share one synchronous ordinary snapshot transaction. */
export function applySnapshotOpenSelection(
  state: WebSessionTabsSyncState,
  patch: WebSessionTabsSyncState | Partial<WebSessionTabsSyncState>,
  worktreeId: string,
  environmentId: string,
  placements: readonly SnapshotOpenPlacement[],
  hostToLocalTabId: ReadonlyMap<string, string>
): WebSessionTabsSyncState | Partial<WebSessionTabsSyncState> {
  const requested = placements.find((entry) => entry.activate)
  if (!requested) {
    return patch
  }
  const next = { ...state, ...patch }
  const localId = requested && hostToLocalTabId.get(requested.hostTabId)
  const tab = localId && next.unifiedTabsByWorktree[worktreeId]?.find((row) => row.id === localId)
  if (
    !tab ||
    !next.groupsByWorktree[worktreeId]?.some((group) => group.tabOrder.includes(tab.id))
  ) {
    return patch
  }
  const activation = tabActivationPatch(next, tab, worktreeId, { recordFocus: false }, true)
  const activated = { ...next, ...activation }
  const surface = deriveActiveSurfaceForWorktree(activated, worktreeId, tab.groupId, {
    preferredTabId: tab.id
  })
  return {
    ...patch,
    ...activation,
    ...snapshotOpenSelectionRecords(next, worktreeId, surface),
    ...(isFloatingWorkspaceId(worktreeId)
      ? {}
      : {
          ...surface,
          ...(state.worktreeNavHistory &&
          state.worktreeNavHistoryIndex !== undefined &&
          !state.isNavigatingHistory
            ? appendHistoryEntry(
                {
                  worktreeNavHistory: state.worktreeNavHistory,
                  worktreeNavHistoryIndex: state.worktreeNavHistoryIndex
                },
                worktreeId
              )
            : {}),
          activeWorktreeId: worktreeId,
          activeWorkspaceKey: isWorkspaceKey(worktreeId)
            ? worktreeId
            : worktreeWorkspaceKey(worktreeId),
          activeWorkspaceExecutionHostId: executionHostIdForSessionTabsOwner(environmentId),
          activePendingCreationId: null,
          activeView: 'terminal' as const
        })
  }
}
