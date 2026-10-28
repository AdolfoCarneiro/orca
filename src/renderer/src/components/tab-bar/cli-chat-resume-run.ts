import {
  captureTerminalSurfaceIdentity,
  isRetainedTerminalSurfaceIdentity
} from '../../../../shared/terminal-tab-close'
import { toast } from 'sonner'
import {
  conversationSwitchFailureText,
  conversationSwitchSourceKept
} from '@/lib/conversation-switch-feedback'
import {
  conversationSwitchChanged,
  isCliChatResumePending,
  pendingCliChatResumes as pending
} from '@/lib/pending-conversation-surface-switches'
import { useAppStore } from '@/store'
import { newAgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import { adoptAgentSessionLaunchVerdict } from '@/lib/agent-session-launch-plan'
import { beginStructuredAgentSessionProvisionalLaunch } from '@/lib/agent-session/structured-agent-session-provisional-tab'
import { structuredAgentSessionTargetForHost } from '@/runtime/structured-agent-session-owner'
import { resolveCliChatResumeSource, type CliChatResumeSource } from './cli-chat-resume-source'
import { reportCliChatResumeFailure } from './cli-chat-resume-feedback'
import { adoptingAgentOnHost } from '../right-sidebar/ai-vault-session-resume-in-chat-launch'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { captureSourceTerminal } from './cli-chat-resume-terminal-capture'
import { agentSessionRefusalError } from '../../../../shared/agent-session-wire-refusals'
import { captureConversationSwitchSelection } from '@/lib/conversation-switch-state'

/** Old peers stop the addressed PTY before ordinary adoption; a kill acknowledgement is never exit proof. */
export async function runLegacyCliChatResume(
  source: CliChatResumeSource,
  viewerSelection?: string
): Promise<void> {
  const key = `${source.executionHostId}\0${source.agent}\0${source.providerSessionId}`
  const target = structuredAgentSessionTargetForHost(source.executionHostId)
  if (!target || source.hostUpdateRequired || isCliChatResumePending(key)) {
    return
  }
  const stillSelected = captureConversationSwitchSelection(viewerSelection)
  const leafId = source.paneKey.slice(source.tabId.length + 1)
  const rendererIdentity = captureTerminalSurfaceIdentity(
    useAppStore.getState(),
    source.workspaceId,
    source.tabId,
    leafId
  )
  const stillCaptured = () => {
    const current = captureTerminalSurfaceIdentity(
      useAppStore.getState(),
      source.workspaceId,
      source.tabId,
      leafId
    )
    return (
      rendererIdentity !== null &&
      current !== null &&
      isRetainedTerminalSurfaceIdentity(rendererIdentity, current)
    )
  }
  const controller = new AbortController()
  const isCurrent = () => {
    const current = resolveCliChatResumeSource(useAppStore.getState(), {
      tab: { id: source.tabId, worktreeId: source.workspaceId },
      paneKey: source.paneKey
    })
    return (
      current?.ptyId === source.ptyId &&
      current?.executionHostId === source.executionHostId &&
      current?.providerSessionId === source.providerSessionId &&
      current?.agent === source.agent
    )
  }
  pending.set(controller, { key, source })
  conversationSwitchChanged()
  try {
    const captured = await captureSourceTerminal(source)
    const ptyId = captured?.presentation.identity.ptyId
    if (!captured || !ptyId || !isCurrent()) {
      throw stopUnknown()
    }
    if (!stillCaptured() || !stillSelected()) {
      return
    }
    const agent = await adoptingAgentOnHost(
      source.agent,
      source.workspaceId,
      source.executionHostId
    )
    if (!isCurrent() || !stillCaptured() || !stillSelected()) {
      return
    }
    const stopped = await callRuntimeRpc<{
      stoppedPtyIds?: string[]
      postStopVerified?: boolean
      remainingLivePtyIds?: string[]
    }>(captured.target, 'terminal.stopExact', {
      worktree: `id:${source.workspaceId}`,
      expectedPtyIds: [ptyId],
      targetOnly: true,
      keepHistory: true
    }).catch(() => {
      throw stopUnknown()
    })
    if (
      !stopped ||
      stopped.postStopVerified !== true ||
      !Array.isArray(stopped.stoppedPtyIds) ||
      stopped.stoppedPtyIds.length !== 1 ||
      stopped.stoppedPtyIds[0] !== ptyId ||
      (stopped.remainingLivePtyIds !== undefined &&
        (!Array.isArray(stopped.remainingLivePtyIds) ||
          stopped.remainingLivePtyIds.includes(ptyId)))
    ) {
      throw stopUnknown()
    }
    const current = resolveCliChatResumeSource(useAppStore.getState(), {
      tab: { id: source.tabId, worktreeId: source.workspaceId },
      paneKey: source.paneKey
    })
    if (current && !isCurrent()) {
      return
    }
    const state = useAppStore.getState()
    if (!stillCaptured() || !stillSelected()) {
      return
    }
    const group = state.groupsByWorktree[source.workspaceId]?.find((row) =>
      row.tabOrder.includes(source.tabId)
    )
    const plan = adoptAgentSessionLaunchVerdict({
      route: 'structured-native-chat',
      requestId: newAgentLaunchRequestId(),
      agent,
      worktreeId: source.workspaceId,
      executionHostId: source.executionHostId,
      resumeFrom: { providerSessionId: source.providerSessionId }
    })
    const launch = beginStructuredAgentSessionProvisionalLaunch({
      plan,
      hooks: { beforeCreate: stillCaptured },
      canActivate: stillSelected,
      afterTabId: source.tabId,
      target: group
        ? {
            surfaceAddress: {
              worktreeId: source.workspaceId,
              targetGroupId: group.id,
              precedingTabIds: group.tabOrder.slice(0, group.tabOrder.indexOf(source.tabId) + 1)
            }
          }
        : undefined
    })
    if (!launch) {
      return
    }
    const result = await launch.settlement
    if (result.kind === 'structured') {
      // Old close envelopes cannot condition retirement on this captured incarnation after adoption.
      toast.info(conversationSwitchSourceKept(source.agent))
    } else if (result.kind === 'failed' && !result.notified) {
      await reportCliChatResumeFailure(source, result.error, target, viewerSelection)
    }
  } catch (error) {
    // A stopped shell can cease being busy or disappear; that never turns proven Stop into a failure.
    toast.error(
      conversationSwitchFailureText(error, { agent: source.agent, direction: 'chat', source })
    )
  } finally {
    pending.delete(controller)
    conversationSwitchChanged()
  }
}

function stopUnknown() {
  return agentSessionRefusalError('agent_session_ownership_unknown', { reason: 'ownerUnproven' })
}
