import { isTuiAgent } from '../../../../shared/tui-agent-config'
import type { AgentSessionRecord } from '../../../../shared/agent-session-record'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import type { z } from 'zod'
import type { RpcContext } from '../core'
import { agentLaunchTabViewerRule } from './agent-launch-tab-publication'
import { SwitchToTerminalParams } from './structured-agent-session-schemas'
import type {
  agentSessionSwitchDeadline,
  AgentSessionSwitchResult
} from '../../../../shared/agent-session-switch-execution'
import { agentSessionRefusalError } from '../../../../shared/agent-session-wire-refusals'
import {
  nativeConversationContent,
  prepareStructuredChatCliTranscript,
  resolveStructuredChatCliSource
} from '../../../ai-vault/structured-chat-cli-fork'

export async function executeStructuredSessionTerminalSwitch(
  params: z.infer<typeof SwitchToTerminalParams>,
  record: AgentSessionRecord,
  ctx: RpcContext,
  host: StructuredAgentSessionHost,
  sessionId: string,
  deadline: ReturnType<typeof agentSessionSwitchDeadline>,
  execution: NonNullable<z.infer<typeof SwitchToTerminalParams>['execution']>,
  selectionCurrent: () => boolean
): Promise<AgentSessionSwitchResult> {
  const agent = record.provider
  if (!isTuiAgent(agent)) {
    throw agentSessionRefusalError('structured_agent_session_unsupported', {
      reason: 'hostUnsupported'
    })
  }
  const terminalExecution = SwitchToTerminalParams.parse(params).execution
  const sourceTabId = terminalExecution?.sourceTabId
  let workCurrent = () => false
  const retire = ctx.runtime.captureSessionSwitchRetirement(
    record.location.workspaceId,
    sessionId,
    sourceTabId,
    () => workCurrent(),
    () => host.retainSwitch(sessionId),
    {
      invocationId: execution.invocationId,
      generation: host.switchGeneration(sessionId)!,
      sessionId,
      tabId: sourceTabId ?? `agent-session:${sessionId}`,
      phase: 'prepare'
    }
  )
  workCurrent = await host.stopForSwitch(
    sessionId,
    { callerKey: 'trusted-local:session-switch' },
    deadline
  )
  host.guardSwitchWork(sessionId, workCurrent)
  const snapshot = await host.journalSnapshot(sessionId)
  deadline.check()
  const content = nativeConversationContent(snapshot)
  if (content === 'uncertain') {
    throw agentSessionRefusalError('agent_session_operation_invalid', {
      reason: 'messagesUnsettled'
    })
  }
  const prepared =
    content === 'saved'
      ? await prepareStructuredChatCliTranscript(
          await resolveStructuredChatCliSource(
            { sessionId, workspaceId: record.location.workspaceId },
            false
          ),
          (args) => ctx.runtime.prepareAiVaultSessionResume(args),
          false
        )
      : undefined
  deadline.check()
  if (content === 'saved' && !prepared?.cliForkSource) {
    throw agentSessionRefusalError('agent_session_identity_required', {
      reason: 'transcriptNotFound'
    })
  }
  deadline.check()
  const placement = retire.placement() ?? {
    afterTabId: sourceTabId,
    groupId: terminalExecution?.groupId
  }
  const terminal = await ctx.runtime.createSessionSwitchTerminal(record.location.workspaceId, {
    invocationId: execution.invocationId,
    sessionId,
    agent,
    source: prepared?.cliForkSource,
    commandOverride: terminalExecution?.commandOverride,
    options: record.options,
    afterTabId: sourceTabId,
    groupId: terminalExecution?.groupId,
    execution: {
      invocationId: execution.invocationId,
      openPlacement: {
        invocationId: execution.invocationId,
        generation: host.switchGeneration(sessionId)!,
        placement,
        activate: true,
        viewerSelection: execution.viewerSelection
      },
      signal: deadline.signal,
      trackPhysical: (work, recover) => host.trackSwitchPhysical(sessionId, work, recover),
      remaining: deadline.remaining,
      check: () => {
        deadline.check()
        if (!workCurrent()) {
          throw agentSessionRefusalError('agent_session_operation_invalid', {
            reason: 'messagesUnsettled'
          })
        }
      },
      selectionCurrent,
      viewerSelection: execution.viewerSelection,
      viewer: agentLaunchTabViewerRule(ctx, 'focused')
    }
  })
  if (terminal.agentResumeRefused || terminal.agentResumeUnavailable) {
    return {
      status: 'refused',
      sessionId,
      refusal: agentSessionRefusalError('agent_session_operation_unknown', {
        reason: 'outcomeUnknown'
      }).refusal
    }
  }
  if (terminal.switchOutcomeUnknown) {
    return {
      status: 'uncertain',
      sessionId,
      refusal: agentSessionRefusalError('agent_session_operation_unknown', {
        reason: 'outcomeUnknown'
      }).refusal
    }
  }
  const retired = await retire()
  return {
    status: 'completed',
    sessionId,
    terminal: terminal.tab.id,
    sourceRetained: Boolean(sourceTabId && !retired)
  }
}
