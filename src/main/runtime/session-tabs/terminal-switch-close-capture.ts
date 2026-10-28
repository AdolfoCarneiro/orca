import { loadChatTabLayout, type ChatTabPlacement } from '../agent-session/agent-session-tab-layout'
import { windowListsTab } from '../terminal/surface/main-terminal-surfaces'
import { isOriginalTerminalHandle } from '../workspace-session-terminal-tab-retirement-identity'
import {
  matchesTerminalSurfaceCapture,
  type TerminalSurfaceCloseCapture
} from '../../../shared/terminal-tab-close'
import { OrcaRuntimeWithExplicitTerminalTabClose } from './explicit-terminal-tab-close'
export abstract class OrcaRuntimeWithTerminalSwitchCloseCapture extends OrcaRuntimeWithExplicitTerminalTabClose {
  captureTerminalSwitchClose(
    handle: string,
    incarnation: string,
    originalPresentation: TerminalSurfaceCloseCapture,
    replacement = true
  ) {
    const source = originalPresentation.identity
    const record = this.handles.get(handle)
    const currentPty = source.ptyId ? this.ptysById.get(source.ptyId) : null
    const leaf = this.leaves.get(this.getLeafKey(source.tabId, source.leafId))
    if (
      !source.ptyId ||
      !incarnation ||
      !isOriginalTerminalHandle({
        runtimeId: this.runtimeId,
        record,
        currentPty,
        paneOfPty: (current) => this.paneOfPty(current),
        leaf,
        source,
        incarnation
      }) ||
      !matchesTerminalSurfaceCapture(
        originalPresentation,
        this.getWorkspaceSessionHostIdsForTab(source.worktreeId, source.tabId),
        (hostId) => this.store?.getWorkspaceSession?.(hostId)
      )
    ) {
      throw new Error('terminal_handle_stale')
    }
    const readPlacement = (): ChatTabPlacement | undefined => {
      const session = this.getWorkspaceSessionForWorktree(source.worktreeId)
      if (!session) {
        return undefined
      }
      const { loaded } = loadChatTabLayout(
        this.getWorkspaceSessionHostIdForWorktree(source.worktreeId),
        session,
        source.worktreeId
      )
      const group = loaded.layout.workspaces[source.worktreeId]?.groups.find((row) =>
        row.tabOrder.includes(source.tabId)
      )
      return group
        ? {
            groupId: group.id,
            afterTabId: source.tabId,
            index: group.tabOrder.indexOf(source.tabId)
          }
        : undefined
    }
    const originalPlacement = readPlacement()
    const addressedPty = source.ptyId
    const rendererOwnsPresentation = windowListsTab(this, this.tabs, source.tabId)
    const proof = {
      parentTabId: source.tabId,
      leafId: source.leafId,
      ptyId: source.ptyId,
      terminal: handle,
      incarnationId: incarnation
    }
    return {
      source,
      placement: () => readPlacement() ?? originalPlacement,
      stop: async () => {
        const stop = await this.stopExplicitlyClosedTabPtys(
          [addressedPty],
          addressedPty,
          incarnation
        )
        if (!stop.stopped) {
          throw new Error('terminal_close_unverifiable')
        }
      },
      retire: async () => {
        const outcome = await this.closeMobileSessionTab(`id:${source.worktreeId}`, source.tabId, {
          originalPresentation,
          rendererOwnsPresentation,
          localPtyTeardownOwnedExternally: true,
          force: replacement,
          retirementProofs: [proof]
        })
        if (outcome.refused) {
          throw new Error('terminal_pane_close_failed')
        }
        this.claudeAgentTeams.removeTeamForLeaderHandle(handle)
        return this.describeTerminalClose(handle, source.tabId, source.ptyId, { stopped: true })
      }
    }
  }
}
