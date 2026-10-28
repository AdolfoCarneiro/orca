import { SessionRoutingCatalog } from './session-routing-catalog'
import type { HostSessionRouting } from './workspace-session-host-persistence'
import type { AppState } from '../store/types'
import { SESSION_RELEVANT_FIELDS } from './workspace-session'
import { buildWorkspaceSessionPatch } from './workspace-session-patch'
import { SESSION_MAP_FIELDS, type SessionMapField } from '../../../shared/session-change-set'
import { SessionUnitIndex } from '../../../shared/session-unit-index'
import type {
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../../../shared/workspace-session-state-types'
import { groupSessionFiles, type SessionSourceField } from './session-source-discovery'

import { parseAppSshPtyId } from '../../../shared/ssh-pty-id'
export const SOURCE_MAPS = {
  tabsByWorktree: 'tabsByWorktree',
  terminalLayoutsByTabId: 'terminalLayoutsByTabId',
  localOnlyScrollbackByTabId: 'localOnlyScrollbackByTabId',
  activeTabIdByWorktree: 'activeTabIdByWorktree',
  activeFileIdByWorktree: 'activeFileIdByWorktree',
  activeTabTypeByWorktree: 'activeTabTypeByWorktree',
  markdownFrontmatterVisible: 'markdownFrontmatterVisible',
  browserTabsByWorktree: 'browserTabsByWorktree',
  browserPagesByWorkspace: 'browserPagesByWorkspace',
  activeBrowserTabIdByWorktree: 'activeBrowserTabIdByWorktree',
  unifiedTabsByWorktree: 'unifiedTabs',
  groupsByWorktree: 'tabGroups',
  layoutByWorktree: 'tabGroupLayouts',
  activeGroupIdByWorktree: 'activeGroupIdByWorktree',
  lastVisitedAtByWorktreeId: 'lastVisitedAtByWorktreeId',
  defaultTerminalTabsAppliedByWorktreeId: 'defaultTerminalTabsAppliedByWorktreeId',
  sleepingAgentSessionsByPaneKey: 'sleepingAgentSessionsByPaneKey',
  clientHostedBrowserCloseIntentsByEnvironment: 'clientHostedBrowserCloseIntentsByEnvironment',
  pairedTerminalTabCloseIntentsByEnvironment: 'pairedTerminalTabCloseIntentsByEnvironment'
} as const satisfies Partial<Record<SessionSourceField, SessionMapField>>
export const RECONNECT_FIELDS = new Set<SessionSourceField>([
  'ptyIdsByTabId',
  'lastKnownRelayPtyIdByTabId',
  'pendingReconnectPtyIdByTabId',
  'deferredSshSessionIdsByTabId'
])
export type SessionProjectionUpdate = {
  patch: WorkspaceSessionPatch
  keys: ReadonlyMap<SessionMapField, ReadonlySet<string>>
  workspaces: ReadonlySet<string>
  connections?: ReadonlyMap<string, boolean>
  full: boolean
  routing?: HostSessionRouting
  routingChanged?: boolean
}

/** Membership is rebuildable; source arrays and Records remain the only value authority. */

export class SessionProjectionIndex {
  protected index: SessionUnitIndex
  protected catalog: SessionRoutingCatalog
  protected readonly remoteConnectionByTab = new Map<string, string>()
  protected readonly remoteConnectionCounts = new Map<string, number>()
  constructor(state: AppState) {
    this.catalog = new SessionRoutingCatalog(state)
    this.index = new SessionUnitIndex(this.rawSession(state))
    const initial = buildWorkspaceSessionPatch(state, ['tabsByWorktree'])
    for (const [id, pty] of Object.entries(initial.remoteSessionIdsByTabId ?? {})) {
      this.replaceConnection(id, pty)
    }
  }
  protected replaceConnection(tabId: string, ptyId: string | undefined): void {
    const before = this.remoteConnectionByTab.get(tabId)
    if (before) {
      const count = (this.remoteConnectionCounts.get(before) ?? 0) - 1
      if (count) {
        this.remoteConnectionCounts.set(before, count)
      } else {
        this.remoteConnectionCounts.delete(before)
      }
    }
    const next = ptyId && parseAppSshPtyId(ptyId)?.connectionId
    if (next) {
      this.remoteConnectionByTab.set(tabId, next)
      this.remoteConnectionCounts.set(next, (this.remoteConnectionCounts.get(next) ?? 0) + 1)
    } else {
      this.remoteConnectionByTab.delete(tabId)
    }
  }
  protected rawSession(state: AppState): WorkspaceSessionState {
    const session: WorkspaceSessionState = {
      activeRepoId: state.activeRepoId,
      activeWorktreeId: state.activeWorktreeId,
      activeTabId: state.activeTabId,
      tabsByWorktree: state.tabsByWorktree,
      terminalLayoutsByTabId: state.terminalLayoutsByTabId,
      openFilesByWorktree: Object.fromEntries(groupSessionFiles(state.openFiles))
    }
    for (const [source, field] of Object.entries(SOURCE_MAPS)) {
      Object.assign(session, { [field]: Reflect.get(state, source) })
    }
    return session
  }
  full(state: AppState): SessionProjectionUpdate {
    this.index = new SessionUnitIndex(this.rawSession(state))
    const patch = buildWorkspaceSessionPatch(state, SESSION_RELEVANT_FIELDS)
    const keys = new Map<SessionMapField, ReadonlySet<string>>()
    for (const field of SESSION_MAP_FIELDS) {
      if (patch[field] !== undefined) {
        keys.set(field, new Set(Object.keys(patch[field] ?? {})))
      }
    }
    return {
      patch,
      keys,
      workspaces: new Set([
        ...Object.keys(state.tabsByWorktree),
        ...(patch.activeWorktreeIdsOnShutdown ?? [])
      ]),
      full: true,
      routing: this.catalog.routing,
      routingChanged: true
    }
  }
}
