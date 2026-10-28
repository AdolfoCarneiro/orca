import type { z } from 'zod'
import type { RpcContext } from '../core'
import { DaemonConnectionLostError, DaemonRequestTimeoutError } from '../../../daemon/daemon-errors'
import { isAgentSessionOperationOutcomeUnknown } from '../../runtime-agent-launch-resolution'
import type { SwitchToChatParams, SwitchToTerminalParams } from './structured-agent-session-schemas'
import {
  agentSessionSwitchDeadline,
  type AgentSessionSwitchResult
} from '../../../../shared/agent-session-switch-execution'
import {
  AgentSessionRefusalError,
  agentSessionRefusalError,
  isAgentSessionRefusalError,
  refuseUnclassified
} from '../../../../shared/agent-session-wire-refusals'
import {
  nativeConversationContent,
  prepareStructuredChatCliTranscript,
  resolveStructuredChatCliSource
} from '../../../ai-vault/structured-chat-cli-fork'
import {
  ensureStructuredHostInstalled,
  requireStructuredSessionHost,
  requireStructuredHost,
  structuredCallerFor
} from './structured-agent-session-gate'
import {
  prepareStructuredAgentSessionCreateForWorktree,
  commitStructuredAgentSessionCreate
} from './structured-agent-session-create'
import { inPlaceSwitchEnabled } from '../../../../shared/structured-agent-cli-conversation-adoption'
import {
  cleanupSwitchedSourceShell,
  recordWorkspace,
  switchRetainedOwner
} from './structured-agent-session-switch-source'
import { executeStructuredSessionTerminalSwitch } from './structured-agent-session-switch-terminal-execution'

export async function executeStructuredSessionSwitch(
  params: z.infer<typeof SwitchToChatParams> | z.infer<typeof SwitchToTerminalParams>,
  ctx: RpcContext,
  direction: 'chat' | 'terminal'
): Promise<AgentSessionSwitchResult> {
  const deadline = agentSessionSwitchDeadline()
  let sessionId = params.sessionId
  let commandOwned = false
  const operation = (async (): Promise<AgentSessionSwitchResult> => {
    await ensureStructuredHostInstalled(ctx)
    deadline.check()
    const execution = params.execution
    if (!execution) {
      throw agentSessionRefusalError('agent_session_operation_invalid', {
        reason: 'requestMalformed'
      })
    }
    const create = 'create' in execution ? execution.create : undefined
    const host = create
      ? requireStructuredHost(ctx, create.agent)
      : requireStructuredSessionHost(ctx, sessionId)
    commandOwned = true
    return host.runSwitch(
      sessionId,
      execution.invocationId,
      deadline,
      async () => {
        if (create && !execution.receipt && !execution.observe) {
          if (
            direction !== 'chat' ||
            create.envelope.sessionId !== sessionId ||
            create.agent !== 'codex'
          ) {
            throw agentSessionRefusalError('agent_session_operation_invalid', {
              reason: 'requestMalformed'
            })
          }
          try {
            const prepared = await prepareStructuredAgentSessionCreateForWorktree({
              ...create,
              runtime: ctx.runtime,
              caller: structuredCallerFor(ctx),
              atRest: true,
              ensureHost: async () => requireStructuredHost(ctx, create.agent),
              structuredAgentCliSourceEvidence: ctx.structuredAgentCliSourceEvidence
            })
            deadline.check()
            const created = await commitStructuredAgentSessionCreate({
              runtime: ctx.runtime,
              caller: structuredCallerFor(ctx),
              prepared,
              activate: true,
              tabPlacement: create.tabPlacement,
              check: deadline.check
            })
            if (!created.ok) {
              const owner = switchRetainedOwner(host, create, created.refusal)
              if (!owner) {
                return { status: 'refused', sessionId, refusal: created.refusal }
              }
              sessionId = owner
            }
          } catch (error) {
            const owner = isAgentSessionRefusalError(error)
              ? switchRetainedOwner(host, create, error.refusal)
              : null
            if (!owner) {
              throw error
            }
            sessionId = owner
          }
          if (sessionId !== params.sessionId) {
            await host.adoptSwitch(params.sessionId, sessionId)
          }
        }
        const record = host.deps.store.getRecord(sessionId)
        if (!record || !inPlaceSwitchEnabled(record.provider)) {
          throw agentSessionRefusalError('structured_agent_session_unsupported', {
            reason: 'hostUnsupported'
          })
        }
        const workCurrent = host.captureSwitchWork(sessionId, deadline)
        if (direction === 'chat') {
          const source = 'source' in execution ? execution.source : undefined
          let switchWitness: string | undefined
          let witnessBudget = 0
          if (source) {
            const inspection = await ctx.runtime.inspectTerminalProcess(source.terminal, {
              expectedIncarnationId: source.expectedIncarnationId,
              scanChildProcesses: true,
              captureSwitchWitness: execution.invocationId
            })
            deadline.check()
            switchWitness = 'switchWitness' in inspection ? inspection.switchWitness : undefined
            witnessBudget = deadline.remaining()
            if (inspection.childProcessEvidence !== 'no-children') {
              throw inspection.childProcessEvidence === 'children'
                ? agentSessionRefusalError('agent_session_operation_invalid', {
                    reason: 'conversationOpenInTerminal'
                  })
                : agentSessionRefusalError('agent_session_operation_unknown', {
                    reason: 'outcomeUnknown'
                  })
            }
          }
          // Initial creation already imported this source before committing its record.
          if (
            (!create || sessionId !== params.sessionId) &&
            (source || nativeConversationContent(await host.journalSnapshot(sessionId)) === 'saved')
          ) {
            const prepared = await prepareStructuredChatCliTranscript(
              await resolveStructuredChatCliSource(
                { sessionId, workspaceId: record.location.workspaceId },
                false
              ),
              (args) => ctx.runtime.prepareAiVaultSessionResume(args),
              false
            )
            deadline.check()
            if (!prepared.cliForkSource) {
              throw agentSessionRefusalError('agent_session_identity_required', {
                reason: 'transcriptUnreadable'
              })
            }
            await host.refreshSwitchTranscript(sessionId, prepared.cliForkSource, deadline)
          }
          const revealed = await host.revealSession(sessionId)
          deadline.check()
          if (!revealed.readable && revealed.openRefusal) {
            throw new AgentSessionRefusalError(revealed.openRefusal)
          }
          await ctx.runtime.publishStructuredAgentSessionTab({
            ...revealed,
            activate: true,
            check: deadline.check
          })
          deadline.check()
          await host.presentSwitch(sessionId, {
            sessionId,
            workspaceId: revealed.workspaceId,
            agent: 'codex',
            tabId: host.getSessionTabId(sessionId) ?? `agent-session:${sessionId}`,
            ...(create?.tabPlacement ? { placement: create.tabPlacement } : {})
          })
          const starting = host.switchToChat(sessionId, deadline)
          host.openedSwitch(sessionId, {
            status: 'completed',
            sessionId,
            startupPending: true
          })
          const started = await starting
          if (!started.ok) {
            return {
              status: 'refused',
              sessionId,
              refusal: started.refusal,
              ...(started.failureItemId ? { failureItemId: started.failureItemId } : {})
            }
          }
          const cleanup = source
            ? cleanupSwitchedSourceShell(ctx, source, switchWitness, witnessBudget, deadline)
            : Promise.resolve(true)
          return { status: 'completed', sessionId, sourceRetained: !(await cleanup) }
        }
        return executeStructuredSessionTerminalSwitch(
          params,
          record,
          ctx,
          host,
          sessionId,
          deadline,
          workCurrent,
          execution
        )
      },
      direction === 'terminal',
      execution,
      async (check) => {
        check()
        const revealed = await host.revealSession(sessionId)
        check()
        await ctx.runtime.publishStructuredAgentSessionTab({ ...revealed, activate: false, check })
        check()
        ctx.runtime.retainSessionSwitchProjection(
          recordWorkspace(host, sessionId),
          sessionId,
          execution.invocationId,
          host.switchGeneration(sessionId) ??
            execution.receipt?.generation ??
            execution.invocationId
        )
      },
      Boolean(create),
      (generation) =>
        ctx.runtime.convergeSessionSwitchProjection(recordWorkspace(host, sessionId), generation)
    )
  })()
  void operation
    .finally(() => {
      if (!commandOwned) {
        deadline.dispose()
      }
    })
    .catch(() => {})
  try {
    return await deadline.wait(operation)
  } catch (error) {
    const refusal = isAgentSessionRefusalError(error)
      ? error.refusal
      : isAgentSessionOperationOutcomeUnknown(error) ||
          error instanceof DaemonConnectionLostError ||
          error instanceof DaemonRequestTimeoutError
        ? agentSessionRefusalError('agent_session_operation_unknown', { reason: 'outcomeUnknown' })
            .refusal
        : refuseUnclassified(
            'agent_session_owner_restart_failed',
            'The agent could not switch. Try again.'
          )
    return {
      status:
        refusal.code === 'agent_session_operation_expired' ||
        refusal.code === 'agent_session_operation_unknown'
          ? 'uncertain'
          : 'refused',
      sessionId,
      refusal
    }
  }
}
