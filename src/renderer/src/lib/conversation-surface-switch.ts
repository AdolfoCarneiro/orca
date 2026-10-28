import { adoptingAgentOnHost } from '@/components/right-sidebar/ai-vault-session-resume-in-chat-launch'
import { translate } from '@/i18n/i18n'
import { agentLabel } from '../../../shared/ai-vault-session-filters'
import type { ConfirmationDialogContextValue } from '@/components/confirmation-dialog-context'
import { isNativeChatEnabled } from '../../../shared/structured-native-chat-launch-route'
import {
  inPlaceSwitchEnabled,
  adoptsCliConversations
} from '../../../shared/structured-agent-cli-conversation-adoption'
import { toHostSessionPaneKey } from '../../../shared/terminal-surface-id'
import {
  captureSwitchProjection,
  releaseUnsentSwitchProjection
} from './conversation-switch-projection'
import {
  beginSwitchPresentation,
  reportSwitchPresentationFailure,
  settleSwitchPresentation,
  type SwitchPresentationVisit
} from './conversation-switch-presentation'
import { parseExecutionHostId } from '../../../shared/execution-host'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import {
  conversationSwitchFailureText,
  conversationSwitchSourceKept
} from './conversation-switch-feedback'
import { resolveWorktreeExecutionHostPlatform } from './execution-host-facts'
import { structuredAgentSessionTargetForHost } from '@/runtime/structured-agent-session-owner'
import {
  callStructuredAgentSession,
  supportsInPlaceSwitch
} from '@/runtime/structured-agent-session-client'
import { createStructuredAgentSessionLaunchIntent } from './launch-structured-agent-session'
import { createBrowserUuid } from './browser-uuid'
import { captureSourceTerminal } from '@/components/tab-bar/cli-chat-resume-terminal-capture'
import {
  pendingNativeChatCliSwitches as pending,
  conversationSwitchChanged
} from './pending-conversation-surface-switches'
import {
  agentSessionSwitchDeadline,
  AGENT_SESSION_SWITCH_CLIENT_MS,
  type AgentSessionSwitchResult
} from '../../../shared/agent-session-switch-execution'
import { AgentSessionRefusalError } from '../../../shared/agent-session-wire-refusals'
import { prepareAiVaultSessionForResume } from './ai-vault-session-resume-preparation'
import type { CliChatResumeSource } from '@/components/tab-bar/cli-chat-resume-source'
import { captureConversationSwitchViewerSelection } from './conversation-switch-selection'
import { presentConversationSwitchResult } from './conversation-switch-result-selection'
import { runLegacyConversationSwitch } from './conversation-switch-legacy'
import {
  type ConversationSwitch,
  keyFor,
  pendingNow,
  rederiveConversationSwitch,
  conversationSwitchReplying
} from './conversation-switch-state'

export { conversationSwitchFailureText } from './conversation-switch-feedback'

export function runCliChatResume(
  source: CliChatResumeSource,
  confirm?: ConfirmationDialogContextValue
): Promise<void> {
  return runConversationSwitch({ direction: 'chat', ...source, source, confirm }).then(
    () => undefined
  )
}
export function runNativeChatCliSwitch(
  args: Omit<ConversationSwitch, 'direction'> & { onComplete?: () => void }
): Promise<void> {
  return runConversationSwitch({ ...args, direction: 'terminal' })
    .then(() => undefined)
    .finally(args.onComplete)
}

export async function runConversationSwitch(args: ConversationSwitch): Promise<boolean> {
  if (
    !isNativeChatEnabled(useAppStore.getState().settings) ||
    !inPlaceSwitchEnabled(args.agent) ||
    pendingNow(args)
  ) {
    return false
  }
  const viewerSelection = captureConversationSwitchViewerSelection()
  const platform = resolveWorktreeExecutionHostPlatform(
    useAppStore.getState(),
    args.workspaceId,
    undefined
  )
  args = {
    ...args,
    platform: args.platform ?? (platform.kind === 'known' ? platform.platform : undefined)
  }
  const target = structuredAgentSessionTargetForHost(args.executionHostId)
  const hostId = parseExecutionHostId(args.executionHostId)?.id
  if (!target || !hostId) {
    return false
  }
  const deadline = agentSessionSwitchDeadline(Date.now, AGENT_SESSION_SWITCH_CLIENT_MS)
  const key = keyFor(args)
  const feedback =
    args.feedback ?? ((message: string, kind: 'error' | 'info') => toast[kind](message))
  pending.set(key, {
    chatTabId: args.source?.tabId ?? args.chatTabId ?? null,
    workspaceId: args.workspaceId,
    executionHostId: args.executionHostId
  })
  conversationSwitchChanged()
  const invocationId = createBrowserUuid()
  let consented = false
  let sent = false
  let presentation: SwitchPresentationVisit | undefined
  try {
    if (conversationSwitchReplying(args)) {
      const confirmed = await args.confirm?.({
        title: translate(
          'components.tab.bar.switch.stopAndSwitchTitle',
          '{{agent}} is replying. Stop it and switch?',
          { agent: agentLabel(args.agent) }
        ),
        confirmLabel: translate('components.tab.bar.switch.stopAndSwitch', 'Stop and switch'),
        cancelLabel: translate('common.cancel', 'Cancel'),
        compact: true,
        ignoresOpeningGesture: true
      })
      if (!confirmed) {
        return false
      }
    }
    consented = true
    if (args.direction === 'terminal' && args.sessionId && args.chatTabId) {
      captureSwitchProjection(
        useAppStore.getState(),
        args.workspaceId,
        {
          invocationId,
          generation: invocationId,
          sessionId: args.sessionId,
          tabId: args.chatTabId,
          phase: 'prepare'
        },
        () => {}
      )
    }
    if (!(await deadline.wait(supportsInPlaceSwitch(target, args.agent, true)))) {
      await runLegacyConversationSwitch(args, target, viewerSelection)
      return false
    }
    let sessionId = args.sessionId
    let execution: Record<string, unknown> = { invocationId, viewerSelection }
    if (args.direction === 'chat' && args.source) {
      const captured = await deadline.wait(captureSourceTerminal(args.source))
      if (!captured) {
        throw new Error('source unavailable')
      }
      const intent = createStructuredAgentSessionLaunchIntent(
        args.workspaceId,
        await deadline.wait(
          adoptingAgentOnHost(args.source.agent, args.workspaceId, args.source.executionHostId)
        ),
        args.source.executionHostId,
        {
          providerSessionId: args.source.providerSessionId,
          cliSource: {
            workspaceId: args.workspaceId,
            paneKey: toHostSessionPaneKey(args.source.paneKey)
          }
        },
        undefined,
        false
      )
      sessionId = intent.sessionId
      const group = useAppStore
        .getState()
        .groupsByWorktree[args.workspaceId]?.find((row) =>
          row.tabOrder.includes(args.source!.tabId)
        )
      execution = {
        ...execution,
        create: {
          ...intent.params,
          tabPlacement: { groupId: group?.id, afterTabId: args.source.tabId }
        },
        source: {
          terminal: captured.handle,
          expectedIncarnationId: captured.incarnationId,
          originalPresentation: captured.presentation
        }
      }
    } else if (
      args.direction === 'chat' &&
      !sessionId &&
      args.history &&
      adoptsCliConversations(args.history.agent)
    ) {
      const prepared = await deadline.wait(prepareAiVaultSessionForResume(args.history))
      const intent = createStructuredAgentSessionLaunchIntent(
        args.workspaceId,
        await deadline.wait(adoptingAgentOnHost(args.history.agent, args.workspaceId, hostId)),
        hostId,
        {
          providerSessionId: prepared.sessionId
        },
        undefined,
        false
      )
      sessionId = intent.sessionId
      execution = { ...execution, create: intent.params }
    } else if (args.direction === 'terminal') {
      const state = useAppStore.getState()
      execution = {
        ...execution,
        sourceTabId: args.chatTabId ?? undefined,
        groupId: state.groupsByWorktree[args.workspaceId]?.find((row) =>
          row.tabOrder.includes(args.chatTabId ?? '')
        )?.id,
        commandOverride: state.settings?.agentCmdOverrides?.[args.agent]
      }
    }
    const method =
      args.direction === 'chat' ? 'agentSession.switchToChat' : 'agentSession.switchToTerminal'
    const invoke = () =>
      deadline.wait(
        callStructuredAgentSession<AgentSessionSwitchResult>(
          target,
          method,
          { sessionId, execution },
          {
            signal: deadline.signal,
            dispatchObservation: deadline.delegateSend,
            beforeSend: (sentAt) => {
              deadline.beforeSend(sentAt)
              sent = true
            }
          }
        )
      )
    if (args.direction === 'chat' && sessionId) {
      presentation = beginSwitchPresentation(target, sessionId)
    }
    const answer = await invoke()
    if (args.direction === 'chat' && answer.sessionId !== sessionId) {
      presentation?.release()
      presentation = beginSwitchPresentation(target, answer.sessionId)
    }
    if (answer.status !== 'completed') {
      if (!presentation || reportSwitchPresentationFailure(presentation, answer.failureItemId)) {
        feedback(
          conversationSwitchFailureText(new AgentSessionRefusalError(answer.refusal), args),
          'error'
        )
      }
      return false
    }
    if (target.kind === 'environment') {
      await presentConversationSwitchResult(args, target, answer, viewerSelection)
    }
    if (answer.sourceRetained) {
      feedback(conversationSwitchSourceKept(args.agent), 'info')
    }
    return true
  } catch (error) {
    if (!presentation || reportSwitchPresentationFailure(presentation)) {
      feedback(conversationSwitchFailureText(error, args), 'error')
    }
    return false
  } finally {
    if (!sent) {
      releaseUnsentSwitchProjection(invocationId)
    }
    settleSwitchPresentation(presentation)
    deadline.dispose()
    pending.delete(key)
    conversationSwitchChanged()
    if (consented) {
      rederiveConversationSwitch(args)
    }
  }
}

export {
  useConversationSwitchPending,
  useConversationSwitchReadiness,
  type ConversationSwitch
} from './conversation-switch-state'
