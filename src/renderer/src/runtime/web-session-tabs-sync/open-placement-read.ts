import type { SessionTabOpenPlacement } from '../../../../shared/session-tab-placement'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import {
  captureTerminalSurfaceIdentityFromRow,
  isRetainedTerminalSurfaceIdentity
} from '../../../../shared/terminal-tab-close'
import { toWebTerminalSurfaceTabId } from '../../../../shared/terminal-surface-id'
import { captureConversationSwitchViewerSelection } from '../../lib/conversation-switch-selection'
import { isWebSessionCloseIntentPending } from '../web-session-close-intent'
import { LOCAL_STRUCTURED_SESSION_OWNER } from '../local-structured-session-owner'
import { getRemoteRuntimePtyOwner } from '../runtime-terminal-stream'
import { hostSessionTabIdsByLocalTabForWorktree } from './tracking-mappings'
import type { WebSessionTabsSyncState } from './state'

/** Call-local indexes of the same ordinary transaction input, never retained across applies. */
export function createOpenPlacementRead(
  state: WebSessionTabsSyncState,
  worktreeId: string,
  environmentId: string,
  snapshot?: RuntimeMobileSessionTabsResult,
  now = Date.now()
) {
  const tabs = state.unifiedTabsByWorktree[worktreeId] ?? []
  const tabIds = new Set(tabs.map((tab) => tab.id))
  const entityIds = new Map<string, Set<string>>()
  for (const tab of tabs) {
    const ids = entityIds.get(tab.contentType) ?? new Set<string>()
    ids.add(tab.entityId)
    entityIds.set(tab.contentType, ids)
  }
  const localByHost = new Map<string, string>()
  for (const [localId, hostId] of hostSessionTabIdsByLocalTabForWorktree(
    environmentId,
    worktreeId
  )) {
    if (!localByHost.has(hostId)) {
      localByHost.set(hostId, localId)
    }
  }
  const terminalRows = new Map<string, (typeof state.tabsByWorktree)[string][number]>()
  for (const row of state.tabsByWorktree[worktreeId] ?? []) {
    if (!terminalRows.has(row.id)) {
      terminalRows.set(row.id, row)
    }
  }
  type Surface = Extract<NonNullable<typeof snapshot>['tabs'][number], { type: 'terminal' }>
  const surfaces = new Map<string, Map<string, Surface>>()
  for (const tab of snapshot?.tabs ?? []) {
    if (tab.type === 'terminal') {
      const leaves = surfaces.get(tab.parentTabId) ?? new Map<string, Surface>()
      if (!leaves.has(tab.leafId)) {
        leaves.set(tab.leafId, tab)
      }
      surfaces.set(tab.parentTabId, leaves)
    }
  }
  const closingHostIds = new Set<string>()
  for (const close of state.pairedTerminalTabCloseIntentsByEnvironment?.[environmentId] ?? []) {
    if (close.worktreeId === worktreeId) {
      for (const hostId of close.hostTabIds) {
        closingHostIds.add(hostId)
      }
    }
  }
  const localTabId = (hostId: string): string => {
    const mirroredId = toWebTerminalSurfaceTabId(hostId)
    return (
      localByHost.get(hostId) ??
      (tabIds.has(hostId) ? hostId : tabIds.has(mirroredId) ? mirroredId : hostId)
    )
  }
  let viewerSelection: string | undefined
  return {
    localTabId,
    hasTab: (id: string) => tabIds.has(id),
    hasEntity: (kind: string, id: string) => entityIds.get(kind)?.has(id) === true,
    viewerSelectionCurrent: (original?: string): boolean => {
      if (original === undefined) {
        return true
      }
      viewerSelection ??= captureConversationSwitchViewerSelection(state)
      return original === viewerSelection
    },
    sourceCurrent: (intent: SessionTabOpenPlacement): boolean => {
      const source = intent.source
      if (!source) {
        return true
      }
      const tabId = localTabId(source.tabId)
      if (
        source.worktreeId !== worktreeId ||
        state.closedTerminalTabTombstonesByTabId?.[tabId] ||
        closingHostIds.has(source.tabId) ||
        isWebSessionCloseIntentPending({ environmentId }, worktreeId, source.tabId, now)
      ) {
        return false
      }
      const row = terminalRows.get(tabId)
      const current = captureTerminalSurfaceIdentityFromRow(
        state,
        row,
        worktreeId,
        tabId,
        source.leafId
      )
      if (environmentId === LOCAL_STRUCTURED_SESSION_OWNER || tabId === source.tabId) {
        return isRetainedTerminalSurfaceIdentity(source, current)
      }
      const surface = surfaces.get(source.tabId)?.get(source.leafId)
      if (surface) {
        if (
          (surface.ptyId != null && surface.ptyId !== source.ptyId) ||
          (surface.incarnationId != null && surface.incarnationId !== source.incarnationId)
        ) {
          return false
        }
        if (
          current?.ptyId &&
          typeof surface.terminal === 'string' &&
          getRemoteRuntimePtyOwner(current.ptyId)?.terminal !== surface.terminal
        ) {
          return false
        }
      }
      // Mirror creation times belong to this viewer; host PTY/incarnation facts belong to the source.
      return (
        current === null ||
        (current.generation === source.generation && (!current.hasLeaf || source.hasLeaf))
      )
    }
  }
}
