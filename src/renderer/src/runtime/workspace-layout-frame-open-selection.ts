import type { AppState } from '@/store/types'
import type { PublishedWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-published'
import type { WorkspaceLayoutCache } from '@/store/workspace-layout-cache'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { LOCAL_STRUCTURED_SESSION_OWNER } from './local-structured-session-owner'
import type { SnapshotOpenPlacement } from './web-session-tabs-sync/open-placement'
import { createOpenPlacementRead } from './web-session-tabs-sync/open-placement-read'
import { applySnapshotOpenSelection } from './web-session-tabs-sync/open-placement-selection'

/** Frames already carry main's applied layout; only original-view selection remains window-owned. */
export function frameOpenSelectionPatch(
  before: AppState,
  patch: Partial<AppState>,
  cache: WorkspaceLayoutCache,
  keys: readonly string[],
  target: RuntimeClientTarget
): Partial<AppState> {
  const owner =
    target.kind === 'environment' ? target.environmentId : LOCAL_STRUCTURED_SESSION_OWNER
  let next = patch
  for (const key of keys) {
    const layout = cache[key]
    if (!layout) {
      continue
    }
    const placements = frameOpenPlacements(before, layout, owner)
    next = applySnapshotOpenSelection(
      before,
      next,
      key,
      owner,
      placements,
      new Map(layout.tabs.map((tab) => [tab.id, tab.id]))
    )
  }
  return next
}

/** Only an admitted explicit open asks the existing draw owner to materialize an unheld workspace. */
export function frameOpenPlacements(
  before: AppState,
  layout: PublishedWorkspaceLayout,
  owner: string
): SnapshotOpenPlacement[] {
  let read: ReturnType<typeof createOpenPlacementRead> | undefined
  return layout.tabs.flatMap((tab) => {
    const intent = tab.openPlacement
    if (!intent?.activate) {
      return []
    }
    read ??= createOpenPlacementRead(before, layout.worktreeId, owner)
    if (!read.viewerSelectionCurrent(intent.viewerSelection) || !read.sourceCurrent(intent)) {
      return []
    }
    const alreadyPresent = read.hasTab(tab.id) || read.hasEntity(tab.kind, tab.entityId)
    return [
      {
        hostTabId: tab.id,
        intent,
        placement: intent.placement,
        activate: !alreadyPresent || intent.viewerSelection !== undefined
      }
    ]
  })
}
