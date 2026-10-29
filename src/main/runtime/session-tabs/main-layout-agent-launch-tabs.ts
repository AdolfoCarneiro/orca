import { launchTabWithdrawalIdentity } from '../../../shared/agent-launch-tab-publication'
import { OrcaRuntimeWithCloseStructuredAgentSessionTab } from './structured-session-tab-close'
import type {
  AgentLaunchTabPublished,
  AgentLaunchTabPublishRequest
} from '../../../shared/agent-launch-tab-publication'
import type { AgentLaunchPlacementReceipt } from '../../../shared/agent-launch-intent'
import type { AgentLaunchPaneAddress } from '../../../shared/agent-launch-pane-verdict'
import { parseExecutionHostId } from '../../../shared/execution-host'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import type { RuntimePtyWorktreeRecord } from '../runtime-terminal-state-records'

// Main-owned early launch tabs are written before launch and withdrawn through main close; paired-runtime workspaces retain window relay.

/** Where the tab landed against where the launch asked for it, as the window reports it. */
function placementFallback(
  asked: AgentLaunchTabPublishRequest['placement'],
  landed: string,
  anchored: boolean
): AgentLaunchPlacementReceipt['fallback'] {
  if (asked?.groupId !== undefined) {
    return landed === asked.groupId ? undefined : anchored ? 'anchor-group' : 'active-group'
  }
  return asked?.afterTabId !== undefined && !anchored ? 'active-group' : undefined
}

export abstract class OrcaRuntimeWithMainLayoutAgentLaunchTabs extends OrcaRuntimeWithCloseStructuredAgentSessionTab {
  protected abstract getPtyRecordForPaneKey(paneKey: string): RuntimePtyWorktreeRecord | null

  /** Whether a running process holds this pane now: such a pane is attached to, never launched into. */
  hasLiveTerminalForPaneKey(paneKey: string): boolean {
    const pty = this.getPtyRecordForPaneKey(paneKey)
    // Main's bound terminal may survive listing gaps; only certified exit frees its pane.
    return ORCA_LAYOUT_OWNER_IS_MAIN
      ? !!pty && this.getPtyLivenessVerdict(pty.ptyId)?.status !== 'exited'
      : pty?.connected === true
  }

  /** Whether main's layout holds the tab's workspace, so main writes the tab itself. */
  private ownsLaunchTab(worktreeId: string, tabId: string): boolean {
    const hostId = this.getWorkspaceSessionHostIdForTab(worktreeId, tabId)
    return Boolean(
      this.store?.applyLayoutCommand && parseExecutionHostId(hostId)?.kind !== 'runtime'
    )
  }

  private groupOfTab(worktreeId: string, tabId: string): string | undefined {
    return this.getWorkspaceSessionForWorktree(worktreeId)?.unifiedTabs?.[worktreeId]?.find(
      (tab) => tab.entityId === tabId
    )?.groupId
  }

  private launchWithdrawalIdentity(worktreeId: string, tabId: string): string {
    const session = this.getWorkspaceSessionForWorktree(worktreeId)
    return launchTabWithdrawalIdentity(
      session?.terminalLayoutsByTabId?.[tabId]?.root,
      session?.unifiedTabs?.[worktreeId] ?? [],
      session?.tabGroups?.[worktreeId] ?? [],
      tabId
    )
  }

  /** The launch's tab in main's layout; null for a workspace main does not own (today's path). */
  publishAgentLaunchTabInMainLayout(
    request: Omit<AgentLaunchTabPublishRequest, 'requestId'>,
    check?: () => void,
    selectionCurrent?: () => boolean
  ): Promise<AgentLaunchTabPublished> | null {
    const { worktreeId, tabId, leafId, placement } = request
    if (!this.ownsLaunchTab(worktreeId, tabId)) {
      return null
    }
    const existed = this.groupOfTab(worktreeId, tabId) !== undefined
    let withdrawalRoot: string | undefined
    return this.applyLayoutCommand(
      {
        type: 'createTerminalTab',
        workspace: worktreeId,
        tabId,
        leafId,
        viewMode: request.viewMode,
        ...(placement?.groupId ? { groupId: placement.groupId } : {}),
        ...(placement?.afterTabId ? { afterTabId: placement.afterTabId } : {}),
        ...(placement?.index !== undefined ? { index: placement.index } : {}),
        creation: { launchAgent: request.launchAgent }
      },
      {
        ...(check
          ? {
              admit: () => {
                check()
                return true
              }
            }
          : {}),
        onApplied: () => {
          withdrawalRoot = this.launchWithdrawalIdentity(worktreeId, tabId)
          const openPlacement = request.openPlacement
          if (openPlacement) {
            this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId, {
              allowAttachedWindow: true,
              force: true
            })
            const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
            if (snapshot) {
              this.storeMobileSessionSnapshot(worktreeId, {
                ...snapshot,
                tabs: snapshot.tabs.map((tab) =>
                  tab.type === 'terminal' && tab.parentTabId === tabId && tab.leafId === leafId
                    ? {
                        ...tab,
                        openPlacement: {
                          ...openPlacement,
                          activate: openPlacement.activate && (selectionCurrent?.() ?? true)
                        }
                      }
                    : tab
                )
              })
              this.markPaneLiveTitlesDirty()
            }
          }
        }
      }
    ).then((reply) => {
      if (!reply.ok) {
        throw new Error(reply.code)
      }
      const landed = this.groupOfTab(worktreeId, tabId)
      if (!landed) {
        throw new Error('agent_launch_tab_unplaced')
      }
      this.showLaunchTabInWindow(
        { ...request, viewer: (selectionCurrent?.() ?? true) ? request.viewer : 'none' },
        { frameSeq: reply.frameSeq, created: !existed }
      )
      // A retry naming the same tab finds it: the launch made no tab, so it takes none back.
      if (existed) {
        return { tabId, created: false, placement: { groupId: landed } }
      }
      const anchored =
        placement?.afterTabId !== undefined &&
        this.groupOfTab(worktreeId, placement.afterTabId) === landed
      const fallback = placementFallback(placement, landed, anchored)
      return {
        tabId,
        created: true,
        withdrawalRoot,
        placement: { groupId: landed, ...(fallback ? { fallback } : {}) }
      }
    })
  }

  /** Keep window-owned launch outcome, copyable prompt and viewer rules while main owns the tab. */
  private showLaunchTabInWindow(
    request: Omit<AgentLaunchTabPublishRequest, 'requestId'>,
    shownByMain: NonNullable<AgentLaunchTabPublishRequest['shownByMain']>
  ): void {
    if (!this.notifier?.publishAgentLaunchTab || !this.getAvailableAuthoritativeWindow()) {
      return
    }
    // Window display is advisory; launch never waits or fails on it.
    void this.notifier
      .publishAgentLaunchTab({ ...request, shownByMain })
      .catch((error: unknown) => {
        console.warn('[agent-launch] the window did not keep the launch tab main wrote', error)
      })
  }

  /** Withdraw main-owned launch panes, closing the tab for its last pane; false leaves unowned workspaces to window cleanup. */
  async withdrawAgentLaunchPaneInMainLayout(
    pane: AgentLaunchPaneAddress,
    current: () => boolean = () => true,
    withdrawalRoot?: string,
    publicationOwner?: 'main' | 'window'
  ): Promise<boolean> {
    if (!withdrawalRoot || !current()) {
      return false
    }
    if (
      publicationOwner === 'window' ||
      (publicationOwner === undefined && !this.ownsLaunchTab(pane.worktreeId, pane.tabId))
    ) {
      if (!this.supportsConditionalSwitchProjection()) {
        return false
      }
      const published = this.notifier?.publishAgentLaunchTab?.({
        ...pane,
        launchAgent: 'codex',
        viewMode: 'terminal',
        viewer: 'none',
        withdraw: { root: withdrawalRoot }
      })
      return (await published)?.withdrawn === true
    }
    return this.takeBackLaunchPane(pane, current, withdrawalRoot)
  }

  private async takeBackLaunchPane(
    pane: AgentLaunchPaneAddress,
    current: () => boolean,
    captured: string
  ): Promise<boolean> {
    const { worktreeId: workspace, tabId, leafId } = pane
    const read = () => this.getWorkspaceSessionForWorktree(workspace)
    const admit = () => {
      const session = read()
      const root = session?.terminalLayoutsByTabId?.[tabId]?.root
      return (
        current() &&
        root?.type === 'leaf' &&
        root.leafId === leafId &&
        this.launchWithdrawalIdentity(workspace, tabId) === captured &&
        !this.hasLiveTerminalForPaneKey(`${tabId}:${leafId}`) &&
        !session?.terminalPtyIncarnationsByPaneKey?.[`${tabId}:${leafId}`]
      )
    }
    const reply = await this.applyLayoutCommand(
      { type: 'closePane', workspace, tabId, leafId },
      { admit }
    )
    // A pane close keeps a tab's last pane; that pane goes with its tab.
    if (!reply.ok && reply.code === 'last_pane') {
      const closed = await this.applyLayoutCommand(
        {
          type: 'closeTabs',
          workspace,
          tabIds: [tabId],
          recordClose: 'cleanup'
        },
        { admit }
      )
      return closed.ok
    }
    return reply.ok
  }
}
