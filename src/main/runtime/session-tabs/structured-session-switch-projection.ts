import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'

import { retireStructuredAgentSessionTabFrom } from '../agent-session/structured-agent-session-tab-retirement'
import type { ChatTabChange } from '../agent-session/agent-session-tab-layout'
import { createChatTabLayoutQueue } from '../agent-session-tab-layout-queue'
import type { LayoutCommandRunOptions, WindowLayoutCommand } from '../runtime-layout-apply'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import type { LayoutApplyReply } from '../../../shared/workspace-layout/workspace-layout-command-types'

import type { SessionSwitchProjection } from '../../../shared/agent-session-switch-execution'
import { OrcaRuntimeWithCloseMobileSessionTab } from '../session-lifecycle/close/close-mobile-session-tab'

import { loadChatTabLayout } from '../agent-session/agent-session-tab-layout'

export abstract class OrcaRuntimeWithStructuredSessionSwitchProjection extends OrcaRuntimeWithCloseMobileSessionTab {
  protected abstract changeWindowlessChatTabs(
    worktreeId: string,
    changes: readonly ChatTabChange[]
  ): void
  retainSessionSwitchProjection(
    worktreeId: string,
    sessionId: string,
    invocationId: string,
    generation: string
  ): void {
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    if (!snapshot) {
      return
    }
    const next = this.storeMobileSessionSnapshot(worktreeId, {
      ...snapshot,
      snapshotVersion: snapshot.snapshotVersion + 1,
      switchProjections: [
        ...(snapshot.switchProjections ?? []).filter((item) => item.sessionId !== sessionId),
        {
          sessionId,
          invocationId,
          generation,
          tabId: `agent-session:${sessionId}`,
          phase: 'retain'
        }
      ]
    })
    this.emitMobileSessionTabsSnapshot(next)
  }

  convergeSessionSwitchProjection(worktreeId: string, generation: string): void {
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    if (!snapshot?.switchProjections?.some((item) => item.generation === generation)) {
      return
    }
    const next = this.storeMobileSessionSnapshot(worktreeId, {
      ...snapshot,
      snapshotVersion: snapshot.snapshotVersion + 1,
      switchProjections: snapshot.switchProjections.filter((item) => item.generation !== generation)
    })
    this.emitMobileSessionTabsSnapshot(next)
  }

  captureSessionSwitchRetirement(
    worktreeId: string,
    sessionId: string,
    tabId: string | undefined,
    workCurrent: () => boolean,
    restore: () => Promise<void>,
    projection?: SessionSwitchProjection
  ) {
    const read = () => {
      const session = this.getWorkspaceSessionForWorktree(worktreeId)
      const workspace =
        session &&
        loadChatTabLayout(
          this.getWorkspaceSessionHostIdForWorktree(worktreeId),
          session,
          worktreeId
        ).loaded.layout.workspaces[worktreeId]
      const tab = workspace?.tabs.find(
        (row) => row.id === tabId && row.kind === 'agent-session' && row.entityId === sessionId
      )
      const group = workspace?.groups.find((row) => row.tabOrder.includes(tabId ?? ''))
      return tab && group
        ? { tab, group: group.id, before: group.tabOrder.slice(0, group.tabOrder.indexOf(tab.id)) }
        : null
    }
    const captured = JSON.stringify(read())
    const presentationCurrent = () =>
      captured === 'null' ? windowAvailable && viewerSupported : JSON.stringify(read()) === captured
    const announce = (phase: 'prepare' | 'retire' | 'retain') => {
      const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
      if (!snapshot || !projection) {
        return
      }
      const next = this.storeMobileSessionSnapshot(worktreeId, {
        ...snapshot,
        snapshotVersion: snapshot.snapshotVersion + 1,
        switchProjections: [
          ...(snapshot.switchProjections ?? []).filter((item) => item.sessionId !== sessionId),
          { ...projection, phase }
        ]
      })
      this.emitMobileSessionTabsSnapshot(next)
    }
    announce('prepare')
    const windowAvailable = Boolean(this.getAvailableAuthoritativeWindow())
    const viewerSupported = !windowAvailable || this.supportsConditionalSwitchProjection()
    const capturedWindow =
      viewerSupported && projection && tabId && windowAvailable
        ? Promise.resolve(
            this.notifier?.closeSessionTab?.(tabId, worktreeId, { ...projection, phase: 'prepare' })
          ).catch(() => false)
        : undefined
    return async () => {
      const host = getStructuredAgentSessionHost()
      if (!host || !tabId) {
        return false
      }
      if (!viewerSupported) {
        await restore()
        return false
      }
      const admit = () => workCurrent() && presentationCurrent()
      if (capturedWindow && (await capturedWindow) !== true) {
        await restore()
        return false
      }
      if (!admit()) {
        await restore()
        return false
      }
      if (
        !(await host.deps.store.setSwitchedSessionTabVisibility(sessionId, tabId, false, admit))
      ) {
        await restore()
        return false
      }
      if (
        windowAvailable &&
        projection &&
        (await this.notifier?.closeSessionTab?.(tabId, worktreeId, {
          ...projection,
          phase: 'retire'
        })) !== true
      ) {
        await restore()
        return false
      }
      const closed = ORCA_LAYOUT_OWNER_IS_MAIN
        ? await this.queueChatTabChanges(
            () => [{ worktreeId, change: { close: sessionId } }],
            admit
          )
        : windowAvailable
          ? admit()
          : admit() && (this.changeWindowlessChatTabs(worktreeId, [{ close: sessionId }]), true)
      if (!closed || !workCurrent()) {
        await restore()
        return false
      }
      const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
      if (!workCurrent()) {
        await restore()
        return false
      }
      const next = snapshot && retireStructuredAgentSessionTabFrom(snapshot, sessionId)
      if (next) {
        this.storeMobileSessionSnapshot(worktreeId, next)
        this.emitMobileSessionTabsSnapshot(next)
      }
      announce('retire')
      host.notifySessionTabHidden(sessionId)
      return true
    }
  }

  abstract applyLayoutCommand(
    command: WindowLayoutCommand,
    options?: LayoutCommandRunOptions
  ): Promise<LayoutApplyReply>
  protected readonly queueChatTabChanges = createChatTabLayoutQueue({
    sessionOf: (worktreeId) => this.getWorkspaceSessionForWorktree(worktreeId),
    hostIdOf: (worktreeId) => this.getWorkspaceSessionHostIdForWorktree(worktreeId),
    apply: (command, options) => this.applyLayoutCommand(command, options)
  })
}
