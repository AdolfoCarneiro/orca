import { structuredAgentSessionDomainFingerprint } from '../../../shared/structured-agent-session-mutation'
import { useAppStore } from '@/store'
import { resolveWebSessionVisibleTabId } from '@/runtime/web-session-focus-intent'

/** Presentation freshness only; the execution host retains all process authority. */
type ViewerState = Parameters<typeof resolveWebSessionVisibleTabId>[0] &
  Partial<
    Pick<
      ReturnType<typeof useAppStore.getState>,
      | 'activeWorkspaceExecutionHostId'
      | 'activeView'
      | 'worktreeNavHistory'
      | 'worktreeNavHistoryIndex'
    >
  >

export function captureConversationSwitchViewerSelection(
  state: ViewerState = useAppStore.getState()
): string {
  const workspaceId = state.activeWorktreeId ?? ''
  return structuredAgentSessionDomainFingerprint({
    domain: 'conversation-switch-viewer',
    sessionId: workspaceId,
    fields: {
      workspaceId: state.activeWorktreeId,
      executionHostId: state.activeWorkspaceExecutionHostId,
      view: state.activeView,
      history: state.worktreeNavHistory,
      historyIndex: state.worktreeNavHistoryIndex,
      groupId: state.activeGroupIdByWorktree?.[workspaceId],
      tabId: resolveWebSessionVisibleTabId(state, workspaceId)
    }
  })
}

export function conversationSwitchViewerSelectionCurrent(
  selection?: string,
  state?: ViewerState
): boolean {
  return selection === undefined || selection === captureConversationSwitchViewerSelection(state)
}
