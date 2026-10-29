import type { SessionTabOpenPlacement } from '../../../../shared/session-tab-placement'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { createOpenPlacementRead } from './open-placement-read'
import { LOCAL_STRUCTURED_SESSION_OWNER } from '../local-structured-session-owner'
import type { WebSessionTabsSyncState } from './state'

export type SnapshotOpenPlacement = {
  hostTabId: string
  intent: SessionTabOpenPlacement
  placement: SessionTabOpenPlacement['placement']
  activate: boolean
}

export function localOpenPlacementTabId(
  state: WebSessionTabsSyncState,
  worktreeId: string,
  hostTabId: string,
  environmentId: string
): string {
  return createOpenPlacementRead(state, worktreeId, environmentId).localTabId(hostTabId)
}

/** Placement never grants authority over a source the user closed or replaced. */
export function openPlacementSourceCurrent(
  state: WebSessionTabsSyncState,
  worktreeId: string,
  intent: SessionTabOpenPlacement,
  environmentId = LOCAL_STRUCTURED_SESSION_OWNER,
  snapshot?: RuntimeMobileSessionTabsResult,
  now = Date.now()
): boolean {
  return (
    !intent.source ||
    createOpenPlacementRead(state, worktreeId, environmentId, snapshot, now).sourceCurrent(intent)
  )
}

/** Read before close-ledger reconciliation and identity-map replacement in the same apply. */
export function prepareSnapshotOpenPlacements(
  state: WebSessionTabsSyncState,
  snapshot: RuntimeMobileSessionTabsResult,
  environmentId: string,
  now: number
): SnapshotOpenPlacement[] {
  let read: ReturnType<typeof createOpenPlacementRead> | undefined
  return snapshot.tabs.flatMap((tab) => {
    if (tab.type !== 'terminal' && tab.type !== 'agent-session') {
      return []
    }
    const intent = tab.openPlacement
    if (!intent) {
      return []
    }
    read ??= createOpenPlacementRead(state, snapshot.worktree, environmentId, snapshot, now)
    if (!read.sourceCurrent(intent)) {
      return []
    }
    const hostTabId = tab.type === 'terminal' ? tab.parentTabId : tab.id
    const currentId = read.localTabId(hostTabId)
    const alreadyPresent =
      read.hasTab(currentId) ||
      (tab.type === 'agent-session' && read.hasEntity('agent-session', tab.sessionId))
    return [
      {
        hostTabId,
        intent,
        placement: {
          ...intent.placement,
          ...(intent.placement.afterTabId
            ? {
                afterTabId: read.localTabId(intent.placement.afterTabId)
              }
            : {})
        },
        activate:
          intent.activate &&
          (!alreadyPresent || intent.viewerSelection !== undefined) &&
          read.viewerSelectionCurrent(intent.viewerSelection)
      }
    ]
  })
}
