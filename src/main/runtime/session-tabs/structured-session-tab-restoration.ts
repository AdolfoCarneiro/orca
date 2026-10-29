import { withSelectedChatTab } from '../agent-session/agent-session-tab-layout'
import type { OrcaRuntimeWithScheduleMobileSessionTabsChanged as ScheduleMobileSessionTabsChangedMethods } from './session-tabs-change-publication'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import { collectSavedStructuredAgentSessionIds } from '../saved-structured-agent-session-restoration'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { seedStructuredAgentSessionTabIndex } from '../agent-session/structured-agent-session-tab-index-seed'
import { restoredChatTabChanges } from './restored-chat-tab-changes'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import type { StructuredAgentId } from '../../../shared/agent-session-provider-handle'
import type { SessionTabOpenPlacement } from '../../../shared/session-tab-placement'
import { projectStructuredSessionTab } from './structured-session-tab-projection'
import { OrcaRuntimeWithStructuredSessionLaunchRuntime } from './structured-session-launch-runtime'

export type AgentLaunchScope = Parameters<
  OrcaRuntimeWithRestoreStructuredAgentSessionTabsOnce['getAgentLaunchPlatformForWorkspace']
>[0]

export abstract class OrcaRuntimeWithRestoreStructuredAgentSessionTabsOnce extends OrcaRuntimeWithStructuredSessionLaunchRuntime {
  protected abstract notifyMobileSessionTabSnapshots(
    ...args: Parameters<ScheduleMobileSessionTabsChangedMethods['notifyMobileSessionTabSnapshots']>
  ): ReturnType<ScheduleMobileSessionTabsChangedMethods['notifyMobileSessionTabSnapshots']>

  protected async restoreStructuredAgentSessionTabsOnce(): Promise<void> {
    await this.prepareStructuredAgentSessionStartupRestoration()
    const host = getStructuredAgentSessionHost()
    const persistedVisibleIndex =
      typeof host?.getPersistedVisibleSessionTabIndex === 'function'
        ? host.getPersistedVisibleSessionTabIndex()
        : { present: false, sessionIds: [] }
    const profileIds = collectSavedStructuredAgentSessionIds(
      this.store?.getWorkspaceSession?.(LOCAL_EXECUTION_HOST_ID) ?? null
    )
    const targets = persistedVisibleIndex.present ? persistedVisibleIndex.sessionIds : profileIds
    await host?.restoreReadableSessions(targets)
    for (const worktreeId of this.getKnownWorkspaceSessionWorktreeIds()) {
      this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId, {
        allowAttachedWindow: true,
        onlyRuntimeOwnedTerminals: true
      })
    }
    this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession()
    // Every session here is of an agent this host registered: its store holds no other agent's records.
    const restored = (host?.listSessionTabs() ?? []).flatMap((session) => {
      let sessionId = session.sessionId
      while (sessionId.startsWith('agent-session:')) {
        sessionId = sessionId.slice('agent-session:'.length)
      }
      return [{ ...session, agent: session.agent, sessionId }]
    })
    await seedStructuredAgentSessionTabIndex(
      host,
      targets,
      restored.map((session) => session.sessionId)
    )
    const changes = restoredChatTabChanges(
      this.store?.getWorkspaceSession?.(LOCAL_EXECUTION_HOST_ID)?.unifiedTabs ?? {},
      host,
      restored
    )
    for (const [worktreeId, worktreeChanges] of changes) {
      this.changeWindowlessChatTabs(worktreeId, worktreeChanges)
    }
    for (const session of restored) {
      this.projectStructuredAgentSessionTab({ ...session, activate: false, notify: false })
    }
    const wasUnverifiable = this.structuredAgentSessionInventoryUnverifiable
    // No host means no one can say which chats exist; with none on disk, empty is the answer.
    this.structuredAgentSessionInventoryUnverifiable =
      !host && this.hasPersistedStructuredAgentSessionStore()
    // This restore published quietly; subscribers still hold the frames that said "cannot tell".
    if (wasUnverifiable && !this.structuredAgentSessionInventoryUnverifiable) {
      this.notifyMobileSessionTabSnapshots()
    }
  }

  captureSessionSwitchSelection(worktreeId?: string): () => boolean {
    const worktrees = worktreeId
      ? [worktreeId]
      : [
          ...new Set([
            ...this.getKnownWorkspaceSessionWorktreeIds(),
            ...this.mobileSessionTabsByWorktree.keys()
          ])
        ].sort()
    for (const id of worktrees) {
      this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(id)
    }
    const read = () => {
      return JSON.stringify(
        worktrees.map((id) => {
          const snapshot = this.mobileSessionTabsByWorktree.get(id)
          const session = this.getWorkspaceSessionForWorktree(id)
          return [
            snapshot?.activeTabId,
            snapshot?.activeGroupId,
            session?.activeTabIdByWorktree?.[id],
            session?.activeGroupIdByWorktree?.[id],
            session?.tabGroups?.[id]
              ?.filter((group) => group.activeTabId != null)
              .map((group) => [group.id, group.activeTabId]) ?? []
          ]
        })
      )
    }
    const captured = read()
    return () => captured === read()
  }

  async publishStructuredAgentSessionTab(input: {
    workspaceId: string
    sessionId: string
    agent: StructuredAgentId
    activate: boolean
    check?: () => void
    selectionCurrent?: () => boolean
    viewerSelection?: string
    focusWindow?: boolean
    notify?: boolean
    /** The host tab id a create reserved; a session that already has a tab keeps its own. */
    tabId?: string
    /** This machine's window made the create; its own open places the tab. */
    placedByWindow?: boolean
    /** Where the creating paired client opens the chat. */
    /** A ChatTabPlacement, typed in place: this file is at its line limit. */
    placement?: { groupId?: string; afterTabId?: string; index?: number }
    openPlacement?: SessionTabOpenPlacement
  }): Promise<void> {
    const host = getStructuredAgentSessionHost()
    input.check?.()
    // First membership includes placement, even while visibility or the durable queue is awaited.
    if (input.openPlacement) {
      this.projectStructuredAgentSessionTab({ ...input, activate: false, notify: false })
    }
    if (input.check && host) {
      await host.deps.store.setSessionTabVisibility(input.sessionId, true, input.tabId, input.check)
    } else if (typeof host?.setSessionTabVisibility === 'function') {
      // Restore-index failures (newer records/disk errors) are reported without preventing tab open.
      await host
        .setSessionTabVisibility(input.sessionId, true, ...(input.tabId ? [input.tabId] : []))
        .catch((error: unknown) => {
          host.deps.logger.warn('recording an opened chat tab failed', {
            scope: 'tab-visibility-open',
            sessionId: input.sessionId,
            error
          })
        })
    }
    // Window creates retain the window's own placement decision.
    input.check?.()
    if (input.check && (ORCA_LAYOUT_OWNER_IS_MAIN || !this.getAvailableAuthoritativeWindow())) {
      const check = input.check
      const applied = await this.queueChatTabChanges(
        () => [
          {
            worktreeId: input.workspaceId,
            change: { open: { ...input, tabId: input.tabId ?? `agent-session:${input.sessionId}` } }
          }
        ],
        () => {
          check()
          return true
        }
      )
      if (!applied) {
        throw new Error('tab_not_found')
      }
    } else if (!(ORCA_LAYOUT_OWNER_IS_MAIN && input.placedByWindow)) {
      this.saveWindowlessAgentSessionTab(input.workspaceId, input)
    }
    input.check?.()
    const activate = input.activate && (input.selectionCurrent?.() ?? true)
    this.projectStructuredAgentSessionTab({
      ...input,
      activate,
      ...(input.openPlacement ? { openPlacement: { ...input.openPlacement, activate } } : {})
    })
    if (activate) {
      input.check?.()
      this.commitWindowlessChatSession(input.workspaceId, (session) =>
        withSelectedChatTab(
          this.getWorkspaceSessionHostIdForWorktree(input.workspaceId),
          session,
          input.workspaceId,
          input.sessionId
        )
      )
      if (input.focusWindow !== false) {
        this.notifier?.focusEditorTab?.(
          input.tabId ??
            host?.getSessionTabId(input.sessionId) ??
            `agent-session:${input.sessionId}`,
          input.workspaceId,
          input.viewerSelection
        )
      }
    }
  }

  /** The runtime's own snapshot of a chat tab. Records nothing: the caller owns the store write. */
  projectStructuredAgentSessionTab(input: {
    workspaceId: string
    sessionId: string
    agent: StructuredAgentId
    activate: boolean
    notify?: boolean
    openPlacement?: SessionTabOpenPlacement
  }): void {
    const next = projectStructuredSessionTab(
      this.mobileSessionTabsByWorktree.get(input.workspaceId),
      input
    )
    if (!next) {
      return
    }
    const stored = this.storeMobileSessionSnapshot(input.workspaceId, next)
    if (input.openPlacement) {
      this.markPaneLiveTitlesDirty()
    }
    if (input.notify !== false) {
      this.emitMobileSessionTabsSnapshot(stored)
    }
  }

  /** A startup's fact: the workspace it starts in, else the new worktree a create is making. */
}
