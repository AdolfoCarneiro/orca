import { adoptsCliConversations } from '../../../shared/structured-agent-cli-conversation-adoption'
import { runLegacyCliChatResume } from '@/components/tab-bar/cli-chat-resume-run'
import { runLegacyNativeChatCliSwitch } from '@/components/tab-bar/native-chat-cli-switch-run'
import { switchIntoOwnerLegacy } from '@/components/tab-bar/cli-chat-resume-feedback'

import { newAgentLaunchRequestId } from './agent-launch-request-id'
import { resumeAiVaultSessionInNewChat } from '@/components/right-sidebar/ai-vault-session-resume-in-chat-launch'

import type { ConversationSwitch } from './conversation-switch-state'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
export function runLegacyConversationSwitch(
  args: ConversationSwitch,
  target: RuntimeClientTarget,
  viewerSelection: string
) {
  if (args.direction === 'terminal' && args.sessionId) {
    return runLegacyNativeChatCliSwitch({
      ...args,
      sessionId: args.sessionId,
      chatTabId: args.chatTabId ?? null,
      viewerSelection
    })
  } else if (args.source) {
    return runLegacyCliChatResume(args.source, viewerSelection)
  } else if (args.sessionId) {
    return switchIntoOwnerLegacy(
      { agent: args.agent, tabId: args.chatTabId ?? '', workspaceId: args.workspaceId },
      { sessionId: args.sessionId, workspaceId: args.workspaceId },
      target,
      viewerSelection
    )
  } else if (args.history && adoptsCliConversations(args.agent)) {
    return resumeAiVaultSessionInNewChat(
      args.history,
      args.agent,
      args.workspaceId,
      newAgentLaunchRequestId(),
      undefined,
      viewerSelection
    )
  }
  return undefined
}
