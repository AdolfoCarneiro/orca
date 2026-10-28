import type { AgentSessionSwitchResult } from '../../../shared/agent-session-switch-execution'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import { refreshWebRuntimeSessionTabsSnapshot } from '@/runtime/web-runtime-session-snapshot'
import { activateStructuredAgentSessionById } from './agent-session/structured-agent-session-tab-activation'
import { presentAgentLaunchTab } from './agent-launch-tab-presentation'
import { conversationSwitchViewerSelectionCurrent } from './conversation-switch-selection'
import type { ConversationSwitch } from './conversation-switch-state'

/** The owning host published membership; this caller alone may move its viewer. */
export async function presentConversationSwitchResult(
  args: ConversationSwitch,
  target: Extract<RuntimeClientTarget, { kind: 'environment' }>,
  result: Extract<AgentSessionSwitchResult, { status: 'completed' }>,
  viewerSelection: string
): Promise<void> {
  await refreshWebRuntimeSessionTabsSnapshot(target.environmentId, args.workspaceId, {
    acceptCurrentSnapshot: true,
    afterCurrentInFlight: true
  }).catch(() => {})
  if (!conversationSwitchViewerSelectionCurrent(viewerSelection)) {
    return
  }
  if (args.direction === 'chat') {
    activateStructuredAgentSessionById({
      worktreeId: args.workspaceId,
      sessionId: result.sessionId,
      target,
      callerOnly: true
    })
  } else if (result.terminal) {
    presentAgentLaunchTab(
      'focus-window',
      args.workspaceId,
      toWebTerminalSurfaceTabId(result.terminal),
      undefined,
      viewerSelection
    )
  }
}
