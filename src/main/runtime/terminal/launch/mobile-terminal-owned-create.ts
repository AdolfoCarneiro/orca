import { OrcaRuntimeWithReconcileOwnedMobileTerminal } from './mobile-terminal-create-reconciliation'
import type {
  RuntimeMobileSessionCreateTerminalResult,
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionTerminalTab
} from '../../../../shared/runtime-types'
import {
  pruneOwnedMobileTerminalDispatchRecipes,
  type OwnedMobileTerminalCreateOptions,
  type OwnedMobileTerminalDispatchRecipe
} from './mobile-terminal-create'
import { randomUUID } from 'node:crypto'
import { copySleepingAgentLaunchConfig } from '../../runtime-agent-launch-resolution'
import { deriveRemoteRuntimeTerminalCreateHandle } from '../../remote-runtime-terminal-create-identity'
import {
  placeCreatedSessionTab,
  captureSessionTabPlacement
} from '../../../../shared/session-tab-placement'
import type { OrcaRuntimeWithBuildPtyTerminalSummary as PtyTerminalSummaryMethods } from '../query/pty-terminal-summary'
import {
  buildHeadlessMobileSessionTabGroups,
  placeHeadlessSessionTabAtCapture,
  buildMaterializedHeadlessParentLayout,
  getHeadlessMobileSessionGroupId
} from '../../mobile-session-layout-projection'

export type { OwnedMobileTerminalCreateOptions } from './mobile-terminal-create'

export abstract class OrcaRuntimeWithCreateRuntimeOwnedMobileSessionTerminal extends OrcaRuntimeWithReconcileOwnedMobileTerminal {
  protected abstract getPtyManualTitle(
    ...args: Parameters<PtyTerminalSummaryMethods['getPtyManualTitle']>
  ): ReturnType<PtyTerminalSummaryMethods['getPtyManualTitle']>

  private readonly ownedMobileDispatchRecipes = new Map<string, OwnedMobileTerminalDispatchRecipe>()

  protected async createRuntimeOwnedMobileSessionTerminal(
    worktreeId: string,
    activate: boolean,
    afterTabId?: string,
    opts: OwnedMobileTerminalCreateOptions = {}
  ): Promise<RuntimeMobileSessionCreateTerminalResult> {
    pruneOwnedMobileTerminalDispatchRecipes(this.ownedMobileDispatchRecipes)
    const workspace = await this.resolveTerminalWorkspaceLaunchScope(`id:${worktreeId}`)
    const cwd = this.resolveWorkspaceTerminalStartupCwd(workspace, opts.cwd)
    // Why: an SSH sessionId means reattach; only synthesize local serve ids so SSH fresh terminals still call pty.spawn.
    const stableSessionId =
      opts.identity?.sessionId ?? (workspace.connectionId ? undefined : `serve-${randomUUID()}`)
    const isNewSession = stableSessionId !== undefined && opts.identity?.sessionId === undefined
    const mutationHandle = opts.createMutation
      ? deriveRemoteRuntimeTerminalCreateHandle(
          opts.createMutation.clientIdentity,
          worktreeId,
          opts.createMutation.id
        )
      : undefined
    const create = (preAllocatedHandle?: string) =>
      this.createTerminal(`id:${worktreeId}`, {
        focus: false,
        ...(opts.presentation ? { presentation: opts.presentation } : {}),
        ...(opts.afterDesktopTabId ? { afterTabId: opts.afterDesktopTabId } : {}),
        beforePtySpawn: opts.beforePtySpawn,
        switchExecution: opts.switchExecution,
        ...(opts.keepPaneOnStartFailure ? { keepPaneOnStartFailure: true as const } : {}),
        onPtySpawnDispatched: (launch) => {
          if (mutationHandle && launch) {
            if (
              !this.ownedMobileDispatchRecipes.has(mutationHandle) &&
              this.ownedMobileDispatchRecipes.size >= 4096
            ) {
              throw new Error('runtime_unavailable')
            }
            // Retain original dispatch evidence across an ambiguous response; retry payloads cannot replace it.
            this.ownedMobileDispatchRecipes.set(mutationHandle, {
              tabId: launch.tabId,
              leafId: launch.leafId,
              connectionId: workspace.connectionId ?? null,
              recordedAt: Date.now(),
              ...(launch.launchConfig
                ? { launchConfig: copySleepingAgentLaunchConfig(launch.launchConfig) }
                : {}),
              ...(launch.launchAgent ? { launchAgent: launch.launchAgent } : {})
            })
          }
          // Why after the recipe: its refusal above is still before dispatch.
          opts.onPtySpawnDispatched?.()
        },
        ...(preAllocatedHandle ? { preAllocatedHandle } : {}),
        command: opts.command,
        ...(opts.shellOverride ? { shellOverride: opts.shellOverride } : {}),
        cwd,
        env: opts.env,
        envToDelete: opts.envToDelete,
        ...(opts.launchConfig ? { launchConfig: opts.launchConfig } : {}),
        ...(opts.resumeProviderSession
          ? { resumeProviderSession: opts.resumeProviderSession }
          : {}),
        ...(opts.spawnIntent ? { spawnIntent: opts.spawnIntent } : {}),
        ...(opts.wslUserAct ? { wslUserAct: true } : {}),
        ...(opts.resumeOrigin ? { resumeOrigin: opts.resumeOrigin } : {}),
        ...(opts.launchAgent ? { launchAgent: opts.launchAgent } : {}),
        ...(opts.launchRuntime ? { launchRuntime: opts.launchRuntime } : {}),
        ...(opts.viewMode ? { viewMode: opts.viewMode } : {}),
        ...(opts.targetGroupId ? { targetGroupId: opts.targetGroupId } : {}),
        startupCommandDelivery: opts.startupCommandDelivery,
        ...(opts.identity
          ? {
              tabId: opts.identity.tabId,
              leafId: opts.identity.leafId,
              ...(stableSessionId ? { sessionId: stableSessionId } : {})
            }
          : stableSessionId
            ? { sessionId: stableSessionId }
            : {}),
        ...(isNewSession ? { isNewSession: true } : {}),
        persistHostSessionBinding: true,
        // Publish only the authoritative snapshot below to avoid a temporary wrong-group placement.
        deferMobileSessionPublish: true,
        signal: opts.signal,
        ...(opts.refuseSleptWorktree ? { refuseSleptWorktree: true } : {}),
        ...(opts.resumesSleepingRecord ? { resumesSleepingRecord: true } : {})
      })
    const beforeCreate = this.mobileSessionTabsByWorktree.get(worktreeId)
    const anchor = beforeCreate?.tabs.find((tab) => tab.id === afterTabId)
    const anchorParentId =
      opts.afterDesktopTabId ?? (anchor?.type === 'terminal' ? anchor.parentTabId : anchor?.id)
    const sourceGroup = beforeCreate?.tabGroups?.find((group) =>
      group.tabOrder.includes(anchorParentId ?? '')
    )
    let targetGroupId = opts.targetGroupId ?? sourceGroup?.id
    const capturedOrder = captureSessionTabPlacement(sourceGroup?.tabOrder ?? [], anchorParentId)
    const capturedTabs = captureSessionTabPlacement(
      beforeCreate?.tabs.map((tab) => tab.id) ?? [],
      afterTabId
    )
    const terminal = opts.createMutation
      ? await this.dedupeTerminalCreate(
          opts.createMutation.clientIdentity,
          `id:${worktreeId}`,
          opts.createMutation.id,
          true,
          (_selector, handle) => create(handle)
        )
      : await create()
    if (terminal.ptyId) {
      opts.onPtyCreated?.(terminal.ptyId, terminal)
    }
    const livePty = this.getLivePtyForHandle(terminal.handle)
    if (!livePty) {
      throw new Error('terminal_handle_stale')
    }
    const dispatched =
      mutationHandle === terminal.handle
        ? this.ownedMobileDispatchRecipes.get(terminal.handle)
        : undefined
    const recipe = opts.createMutation
      ? this.validateOwnedMobileDispatch(
          livePty.pty,
          terminal,
          opts,
          dispatched,
          workspace.connectionId ?? null
        )
      : undefined
    const { tabId: parentTabId, leafId } = await this.reconcileOwnedMobileTerminalSurface(
      worktreeId,
      workspace.connectionId ?? null,
      terminal,
      livePty.pty,
      recipe
    )
    if (opts.createMutation) {
      livePty.pty.runtimeSessionOwned = true
    }
    const existing = this.mobileSessionTabsByWorktree.get(worktreeId)
    const existingSurface =
      existing?.tabs.find(
        (candidate): candidate is RuntimeMobileSessionTerminalTab =>
          candidate.type === 'terminal' &&
          candidate.parentTabId === parentTabId &&
          candidate.leafId === leafId
      ) ?? null
    if (existingSurface) {
      targetGroupId = existing?.tabGroups?.find((group) => group.tabOrder.includes(parentTabId))?.id
    }
    const parentLayout = buildMaterializedHeadlessParentLayout(
      leafId,
      livePty.pty.ptyId,
      existingSurface?.parentLayout
    )
    // A terminal restarted for a saved tab keeps the tab's saved name; a row's null stays cleared.
    const customTitle =
      existingSurface?.customTitle !== undefined
        ? existingSurface.customTitle
        : this.getPtyManualTitle(livePty.pty, false) || undefined
    activate = activate && (opts.switchExecution?.selectionCurrent?.() ?? true)
    const tab: RuntimeMobileSessionTerminalTab = {
      type: 'terminal',
      ...(existingSurface?.openPlacement
        ? {
            openPlacement: {
              ...existingSurface.openPlacement,
              activate: existingSurface.openPlacement.activate && activate
            }
          }
        : opts.switchExecution?.openPlacement
          ? { openPlacement: { ...opts.switchExecution.openPlacement, activate } }
          : {}),
      id: `${parentTabId}::${leafId}`,
      parentTabId,
      leafId,
      ptyId: livePty.pty.ptyId,
      incarnationId: livePty.pty.incarnationId,
      title: existingSurface?.title ?? terminal.title ?? livePty.pty.title ?? 'Terminal',
      ...(customTitle !== undefined ? { customTitle } : {}),
      // Omit only a proven root correction; an unverifiable fallback keeps its saved request.
      ...((terminal.savedStartupCwd ?? cwd) && (terminal.savedStartupCwd ?? cwd) !== workspace.path
        ? { startupCwd: terminal.savedStartupCwd ?? cwd }
        : {}),
      ...(livePty.pty.launchAgent ? { launchAgent: livePty.pty.launchAgent } : {}),
      ...(!terminal.agentResumeRefused && !terminal.agentResumeUnavailable && opts.viewMode
        ? { viewMode: opts.viewMode }
        : {}),
      parentLayout,
      isActive: activate || (existingSurface?.isActive ?? false)
    }
    const currentTabs = (existing?.tabs ?? []).map((candidate) => ({
      ...candidate,
      ...(candidate.type === 'terminal' && candidate.parentTabId === parentTabId
        ? { parentLayout }
        : {}),
      isActive: activate ? false : candidate.isActive
    }))
    const tabs = existingSurface
      ? currentTabs.map((candidate) => (candidate.id === tab.id ? tab : candidate))
      : placeCreatedSessionTab(currentTabs, tab, afterTabId, {
          afterParentGroup: opts.supportsSplitGroupPlacement !== false,
          captured: capturedTabs
        })
    const tabGroups = buildHeadlessMobileSessionTabGroups(
      worktreeId,
      tabs,
      activate ? tab : null,
      existing?.tabGroups,
      targetGroupId ? { tabId: parentTabId, groupId: targetGroupId } : undefined
    )
    if (
      !existingSurface &&
      capturedOrder &&
      (!opts.targetGroupId || opts.targetGroupId === sourceGroup?.id)
    ) {
      placeHeadlessSessionTabAtCapture(tabGroups, tabs, parentTabId, capturedOrder)
    }
    const next: RuntimeMobileSessionTabsSnapshot = {
      worktree: worktreeId,
      // New epochs retire the prior publisher and reject its later updates.
      publicationEpoch: existing?.publicationEpoch ?? `headless:${Date.now().toString(36)}`,
      snapshotVersion: (existing?.snapshotVersion ?? 0) + 1,
      // Activating the new tab must also focus its requested split group.
      activeGroupId:
        activate && targetGroupId && tabGroups.some((group) => group.id === targetGroupId)
          ? targetGroupId
          : (existing?.activeGroupId ?? getHeadlessMobileSessionGroupId(worktreeId)),
      activeTabId: activate ? tab.id : (existing?.activeTabId ?? null),
      activeTabType: activate ? 'terminal' : (existing?.activeTabType ?? null),
      tabGroups,
      // Retain split geometry when adding a tab.
      ...(existing?.tabGroupLayout ? { tabGroupLayout: existing.tabGroupLayout } : {}),
      tabs
    }
    // Store adds retirement proofs; emit that snapshot because version-deduping subscribers would miss proofs from a pre-store frame.
    const stored = this.storeMobileSessionSnapshot(worktreeId, next)
    if (opts.switchExecution?.openPlacement) {
      this.markPaneLiveTitlesDirty()
    }
    const result = this.toMobileSessionTabsResult(stored)
    const changeSequence = ++this.mobileSessionTabsChangeSequence
    for (const subscription of this.mobileSessionTabListeners) {
      subscription.listener(
        this.projectMobileSessionTabsForClient(result, subscription.clientNavigationId),
        changeSequence
      )
    }
    const created = result.tabs.find((candidate) => candidate.id === tab.id)
    if (!created || created.type !== 'terminal') {
      throw new Error('terminal_handle_stale')
    }
    if (recipe && this.ownedMobileDispatchRecipes.get(terminal.handle) === recipe) {
      this.ownedMobileDispatchRecipes.delete(terminal.handle)
    }
    return {
      tab: created,
      ...(terminal.switchOutcomeUnknown ? { switchOutcomeUnknown: true as const } : {}),
      ...(terminal.agentResumeUnavailable ? { agentResumeUnavailable: true as const } : {}),
      ...(terminal.agentResumeRefused ? { agentResumeRefused: true as const } : {}),
      publicationEpoch: result.publicationEpoch,
      snapshotVersion: result.snapshotVersion,
      ...(terminal.startupCwdFallback ? { startupCwdFallback: 'workspace-root' as const } : {})
    }
  }
}
