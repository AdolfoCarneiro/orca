import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { hasAwakeStructuredChat } from '@/store/slices/structured-chat-slept-at'
import { resolveWorktreeStatus, type WorktreeStatus } from '@/lib/worktree-status'
import { EMPTY_BROWSER_TABS, EMPTY_TABS } from './WorktreeCardHelpers'
import {
  selectLivePtyIdsForWorktree,
  selectTerminalLayoutRootsForWorktree,
  selectRuntimePaneTitlesForWorktree
} from './worktree-card-status-inputs'
import { selectWorktreeAgentActivitySummary } from './worktree-agent-activity-summary'
import { selectStoppedWslDistro } from '@/lib/wsl-host-stopped-status'
import { selectWorkspaceRuntimeEnvironmentId } from '../terminal-pane/remote-server-outage'

const NO_LIVE_PTYS: Record<string, string[]> = {}

export function useWorktreeActivityStatus(worktreeId: string): WorktreeStatus {
  const tabs = useAppStore((s) => s.tabsByWorktree[worktreeId] ?? EMPTY_TABS)
  const browserTabs = useAppStore((s) => s.browserTabsByWorktree[worktreeId] ?? EMPTY_BROWSER_TABS)
  const hasStructuredChat = useAppStore((s) =>
    hasAwakeStructuredChat(s.unifiedTabsByWorktree[worktreeId], s.structuredChatSleptAtByPaneKey)
  )
  const runtimePaneTitlesForWorktree = useAppStore(
    useShallow((s) => selectRuntimePaneTitlesForWorktree(s, worktreeId))
  )
  const ptyIdsForWorktree = useAppStore(
    useShallow((s) => selectLivePtyIdsForWorktree(s, worktreeId))
  )
  // A stopped distro ended every terminal in it, whatever bindings the panes keep for its Start.
  // Why the cheap check first: every card subscribes, and almost no host is stopped.
  const hostStopped = useAppStore(
    (s) =>
      Object.values(s.wslHostStatuses ?? {}).some((status) => status.state === 'distro-stopped') &&
      selectStoppedWslDistro(s, selectWorkspaceRuntimeEnvironmentId(s, worktreeId)) !== null
  )
  const terminalLayoutRootsByTabId = useAppStore(
    useShallow((s) => selectTerminalLayoutRootsForWorktree(s, worktreeId))
  )
  const {
    hasPermission,
    hasLiveWorking,
    hasLiveMonitoring,
    hasFailed,
    hasInterrupted,
    hasUnconfirmed,
    hasLiveDone,
    hasRetainedDone,
    hasRetainedFailed,
    agentStatusPaneIdsByTabId,
    stalePaneIdsByTabId
  } = useAppStore(useShallow((s) => selectWorktreeAgentActivitySummary(s, worktreeId)))

  // Use common liveness and agent-row precedence so compact and detailed cards show the same status.
  return useMemo(
    () =>
      resolveWorktreeStatus({
        tabs,
        browserTabs,
        hasStructuredChat,
        ptyIdsByTabId: hostStopped ? NO_LIVE_PTYS : ptyIdsForWorktree,
        runtimePaneTitlesByTabId: runtimePaneTitlesForWorktree,
        agentStatusPaneIdsByTabId,
        stalePaneIdsByTabId,
        terminalLayoutRootsByTabId,
        hasPermission,
        hasLiveWorking,
        hasLiveMonitoring,
        hasFailed,
        hasInterrupted,
        hasUnconfirmed,
        hasLiveDone,
        hasRetainedDone,
        hasRetainedFailed
      }),
    [
      tabs,
      browserTabs,
      hasStructuredChat,
      hostStopped,
      ptyIdsForWorktree,
      runtimePaneTitlesForWorktree,
      agentStatusPaneIdsByTabId,
      stalePaneIdsByTabId,
      terminalLayoutRootsByTabId,
      hasPermission,
      hasLiveWorking,
      hasLiveMonitoring,
      hasFailed,
      hasInterrupted,
      hasUnconfirmed,
      hasLiveDone,
      hasRetainedDone,
      hasRetainedFailed
    ]
  )
}
