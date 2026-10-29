import { OrcaRuntimeWithResolveMobileSessionTerminalCommand } from './mobile-terminal-startup'
import type {
  OwnedMobileTerminalCreateOptions,
  OwnedMobileTerminalDispatchRecipe
} from './mobile-terminal-create'
import type { RuntimeTerminalCreate } from '../../../../shared/runtime-types'
import type { RuntimePtyWorktreeRecord } from '../../runtime-terminal-state-records'
import { copySleepingAgentLaunchConfig } from '../../runtime-agent-launch-resolution'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import {
  ptyHoldsRecordedSurface,
  type PtySurfaceTopology
} from '../../pty-recorded-surface-topology'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { persistFreshPaneBinding } from '../../../ipc/pty/spawn-commit-binding'

export abstract class OrcaRuntimeWithReconcileOwnedMobileTerminal extends OrcaRuntimeWithResolveMobileSessionTerminalCommand {
  protected abstract ptySurfaceTopology(): PtySurfaceTopology

  protected validateOwnedMobileDispatch(
    pty: RuntimePtyWorktreeRecord,
    terminal: RuntimeTerminalCreate,
    opts: OwnedMobileTerminalCreateOptions,
    dispatched: OwnedMobileTerminalDispatchRecipe | undefined,
    connectionId: string | null
  ): OwnedMobileTerminalDispatchRecipe | undefined {
    const recipe =
      dispatched?.connectionId === connectionId &&
      (!pty.launchAgent || pty.launchAgent === dispatched.launchAgent)
        ? dispatched
        : undefined
    const originalAgent = pty.launchAgent ?? recipe?.launchAgent
    if (originalAgent && opts.launchAgent && originalAgent !== opts.launchAgent) {
      throw new Error('terminal_create_identity_conflict')
    }
    if (
      !terminal.agentResumeRefused &&
      !terminal.agentResumeUnavailable &&
      opts.launchConfig &&
      !pty.launchConfig &&
      !recipe?.launchConfig
    ) {
      throw new Error('runtime_unavailable')
    }
    if (recipe && !terminal.agentResumeRefused && !terminal.agentResumeUnavailable) {
      pty.launchAgent ??= recipe.launchAgent ?? null
      if (!pty.launchConfig && recipe.launchConfig) {
        pty.launchConfig = copySleepingAgentLaunchConfig(recipe.launchConfig)
      }
    }
    return recipe
  }

  private currentOwnedMobileSurface(pty: RuntimePtyWorktreeRecord) {
    const recorded = this.paneOfPty(pty)
    if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
      const leaf = this.getLeavesForPty(pty.ptyId).find((row) => row.worktreeId === pty.worktreeId)
      if (leaf) {
        return { tabId: leaf.tabId, leafId: leaf.leafId }
      }
    }
    const pane = parsePaneKey(recorded.paneKey ?? '')
    if (ORCA_LAYOUT_OWNER_IS_MAIN && pane) {
      return pane
    }
    const session = this.getWorkspaceSessionForWorktree(pty.worktreeId)
    for (const tab of session?.tabsByWorktree[pty.worktreeId] ?? []) {
      for (const [leafId, id] of Object.entries(
        session?.terminalLayoutsByTabId[tab.id]?.ptyIdsByLeafId ?? {}
      )) {
        if (
          id === pty.ptyId &&
          (!pty.incarnationId ||
            session?.terminalPtyIncarnationsByPaneKey?.[`${tab.id}:${leafId}`] ===
              pty.incarnationId)
        ) {
          return { tabId: tab.id, leafId }
        }
      }
    }
    if (pane && ptyHoldsRecordedSurface(pty.ptyId, recorded, this.ptySurfaceTopology())) {
      return pane
    }
    if (recorded.tabId || recorded.paneKey) {
      throw new Error('terminal_handle_stale')
    }
    return null
  }

  protected async reconcileOwnedMobileTerminalSurface(
    worktreeId: string,
    connectionId: string | null,
    terminal: RuntimeTerminalCreate,
    pty: RuntimePtyWorktreeRecord,
    recipe: OwnedMobileTerminalDispatchRecipe | undefined
  ) {
    const incarnationId = pty.incarnationId
    const resolve = () => {
      const live = this.getLivePtyForHandle(terminal.handle)?.pty
      if (
        live !== pty ||
        !pty.connected ||
        pty.incarnationId !== incarnationId ||
        pty.worktreeId !== worktreeId ||
        terminal.worktreeId !== worktreeId ||
        pty.connectionId !== connectionId ||
        (terminal.ptyId && terminal.ptyId !== pty.ptyId) ||
        (terminal.incarnationId && terminal.incarnationId !== incarnationId)
      ) {
        throw new Error('terminal_handle_stale')
      }
      const current = this.currentOwnedMobileSurface(pty)
      if (current) {
        return current
      }
      const returned = terminal.tabId && terminal.paneKey ? parsePaneKey(terminal.paneKey) : null
      if (terminal.tabId && terminal.paneKey && (!returned || returned.tabId !== terminal.tabId)) {
        throw new Error('terminal_handle_stale')
      }
      const candidate = returned ?? recipe
      if (!candidate) {
        throw new Error('terminal_handle_stale')
      }
      const leaf = this.leaves.get(this.getLeafKey(candidate.tabId, candidate.leafId))
      if (leaf && (leaf.worktreeId !== worktreeId || (leaf.ptyId && leaf.ptyId !== pty.ptyId))) {
        throw new Error('terminal_handle_stale')
      }
      return { tabId: candidate.tabId, leafId: candidate.leafId }
    }
    const store = this.store
    if (store?.persistPtyBinding && store.getWorkspaceSession) {
      const { persistPtyBinding, getWorkspaceSession } = store
      const persisted = await persistFreshPaneBinding(
        {
          persistPtyBinding: persistPtyBinding.bind(store),
          getWorkspaceSession: getWorkspaceSession.bind(store)
        },
        () => ({
          ...resolve(),
          worktreeId,
          ptyId: pty.ptyId,
          ...(incarnationId ? { incarnationId } : {}),
          mayReviveRetiredSurface: false
        }),
        connectionId
      )
      if (!persisted) {
        throw new Error('terminal_handle_stale')
      }
    }
    const surface = resolve()
    if (
      ORCA_LAYOUT_OWNER_IS_MAIN &&
      this.paneOfPty(pty).paneKey !== `${surface.tabId}:${surface.leafId}`
    ) {
      throw new Error('terminal_handle_stale')
    }
    if (
      !ORCA_LAYOUT_OWNER_IS_MAIN &&
      this.paneOfPty(pty).paneKey !== `${surface.tabId}:${surface.leafId}`
    ) {
      this.registerPty(pty.ptyId, worktreeId, connectionId, {
        ...surface,
        terminalHandle: terminal.handle,
        ...(incarnationId ? { incarnationId } : {})
      })
    }
    return surface
  }
}
