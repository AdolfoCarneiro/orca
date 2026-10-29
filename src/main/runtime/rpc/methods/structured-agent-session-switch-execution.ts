import { retainStructuredSwitchSource } from './structured-agent-session-switch-retention'
import { structuredSessionSwitchFailure } from './structured-agent-session-switch-failure'
import {
  prepareStructuredSessionSwitch,
  requireStructuredSwitchRecord
} from './structured-agent-session-switch-preparation'
import type { z } from 'zod'
import type { RpcContext } from '../core'
import type { SwitchToChatParams, SwitchToTerminalParams } from './structured-agent-session-schemas'
import {
  agentSessionSwitchDeadline,
  type AgentSessionSwitchResult
} from '../../../../shared/agent-session-switch-execution'
import {
  AgentSessionRefusalError,
  agentSessionRefusalError,
  isAgentSessionRefusalError
} from '../../../../shared/agent-session-wire-refusals'
import {
  nativeConversationContent,
  prepareStructuredChatCliTranscript,
  resolveStructuredChatCliSource
} from '../../../ai-vault/structured-chat-cli-fork'
import { structuredCallerFor } from './structured-agent-session-gate'
import {
  prepareStructuredAgentSessionCreateForWorktree,
  commitStructuredAgentSessionCreate
} from './structured-agent-session-create'
import { recordWorkspace, switchRetainedOwner } from './structured-agent-session-switch-source'
import { executeStructuredSessionTerminalSwitch } from './structured-agent-session-switch-terminal-execution'
import { agentLaunchMovesHostWindow } from './agent-launch-tab-publication'
import { interruptWorkingAgent } from '../../terminal-agent-interrupt'
import { mainAgentState } from '../../../../shared/main-agent-status'
import { captureSwitchStoppedCliTurn } from '../../../native-chat/agent-session-wire/structured-agent-session-switch-import'
export async function executeStructuredSessionSwitch(
  params: z.infer<typeof SwitchToChatParams> | z.infer<typeof SwitchToTerminalParams>,
  ctx: RpcContext,
  direction: 'chat' | 'terminal'
): Promise<AgentSessionSwitchResult> {
  const deadline = agentSessionSwitchDeadline()
  let sessionId = params.sessionId
  const selectionCurrent = ctx.runtime.captureSessionSwitchSelection()
  let commandOwned = false
  const operation = (async (): Promise<AgentSessionSwitchResult> => {
    const prepared = await prepareStructuredSessionSwitch(params, ctx, sessionId, deadline)
    const {
      host,
      execution,
      create,
      sourceEvidence,
      createIdentity,
      providerSessionId,
      conversation
    } = prepared
    sessionId = prepared.sessionId
    commandOwned = true
    return host.runSwitch(
      sessionId,
      execution.invocationId,
      deadline,
      async () => {
        if (direction === 'terminal') {
          const record = requireStructuredSwitchRecord(host, sessionId)
          return executeStructuredSessionTerminalSwitch(
            params,
            record,
            ctx,
            host,
            sessionId,
            deadline,
            execution,
            selectionCurrent
          )
        }
        deadline.check()
        const source = 'source' in execution ? execution.source : undefined
        const close = source
          ? (() => {
              try {
                return ctx.runtime.captureTerminalSwitchClose(
                  source.terminal,
                  source.expectedIncarnationId,
                  source.originalPresentation
                )
              } catch {
                host.deps.logger.warn('switch source owner was not confirmed', {
                  scope: 'session-switch',
                  sessionId,
                  direction,
                  source: 'terminal',
                  exactIncarnation: false
                })
                throw agentSessionRefusalError('agent_session_ownership_unknown', {
                  reason: 'ownerUnproven'
                })
              }
            })()
          : undefined
        const paneKey = close ? `${close.source.tabId}:${close.source.leafId}` : undefined
        const row = paneKey ? ctx.runtime.agentTransitions.latestRow(paneKey) : null
        const adopt = createIdentity?.adopt
        const retainedSource =
          !adopt && source
            ? await prepareStructuredChatCliTranscript(
                await resolveStructuredChatCliSource(
                  { sessionId, workspaceId: recordWorkspace(host, sessionId) },
                  false
                ),
                (args) => ctx.runtime.prepareAiVaultSessionResume(args),
                false
              )
            : undefined
        const before = adopt?.transcriptPath
          ? {
              agent: create!.agent,
              sessionId: adopt.providerHandle.nativeId,
              filePath: adopt.transcriptPath
            }
          : retainedSource?.cliForkSource
        const stopped = before
          ? await captureSwitchStoppedCliTurn(
              before,
              Boolean(row && mainAgentState(row) === 'working'),
              deadline
            )
          : undefined
        deadline.check()
        if (close) {
          if (paneKey) {
            await interruptWorkingAgent(
              ctx.runtime,
              (key) => ctx.runtime.agentTransitions.latestRow(key),
              paneKey,
              {
                signal: deadline.signal,
                beforeWrite: async () => {
                  deadline.check()
                }
              }
            )
          }
          // Shutdown already accepted must finish even when the observing request expires.
          try {
            await host.trackSwitchPhysical(sessionId, close.stop())
          } catch {
            host.deps.logger.warn('switch source exit was not confirmed', {
              scope: 'session-switch',
              sessionId,
              direction,
              source: 'terminal',
              exactIncarnation: true
            })
            throw agentSessionRefusalError('agent_session_ownership_unknown', {
              reason: 'ownerUnproven'
            })
          }
        }
        deadline.check()
        if (create) {
          try {
            const preparedCreate = await prepareStructuredAgentSessionCreateForWorktree({
              ...create,
              runtime: ctx.runtime,
              caller: structuredCallerFor(ctx),
              atRest: true,
              ensureHost: async () => host,
              structuredAgentCliSourceEvidence: sourceEvidence
            })
            deadline.check()
            const created = await commitStructuredAgentSessionCreate({
              runtime: ctx.runtime,
              caller: structuredCallerFor(ctx),
              prepared: { ...preparedCreate, tab: null },
              activate: false,
              check: deadline.check
            })
            if (!created.ok) {
              throw new AgentSessionRefusalError(created.refusal)
            }
            sessionId = created.value.sessionId
          } catch (error) {
            const owner =
              isAgentSessionRefusalError(error) &&
              (error.refusal.code === 'agent_session_conflict' ||
                error.refusal.code === 'agent_session_ownership_unknown') &&
              createIdentity &&
              providerSessionId &&
              switchRetainedOwner(host, createIdentity, providerSessionId)
            if (
              !owner ||
              !isAgentSessionRefusalError(error) ||
              error.refusal.details?.owner?.sessionId !== owner
            ) {
              throw error
            }
            sessionId = owner
          }
          await host.adoptSwitch(conversation?.commandKey ?? params.sessionId, sessionId)
        }
        const record = requireStructuredSwitchRecord(host, sessionId)
        const workCurrent = host.captureSwitchWork(sessionId, deadline)
        const check = () => {
          deadline.check()
          if (!workCurrent()) {
            host.deps.logger.warn('switch destination was superseded by newer work', {
              scope: 'session-switch',
              sessionId,
              direction
            })
            throw agentSessionRefusalError('agent_session_operation_invalid', {
              reason: 'messagesUnsettled'
            })
          }
        }
        if (
          source ||
          nativeConversationContent(await host.journalSnapshot(sessionId)) === 'saved'
        ) {
          const transcript = await prepareStructuredChatCliTranscript(
            await resolveStructuredChatCliSource(
              { sessionId, workspaceId: record.location.workspaceId },
              false
            ),
            (args) => ctx.runtime.prepareAiVaultSessionResume(args),
            false
          )
          check()
          if (!transcript.cliForkSource) {
            throw agentSessionRefusalError('agent_session_identity_required', {
              reason: 'transcriptUnreadable'
            })
          }
          await host.refreshSwitchTranscript(
            sessionId,
            transcript.cliForkSource,
            deadline,
            stopped,
            check
          )
        }
        const revealed = await host.revealSession(sessionId)
        check()
        if (!revealed.readable && revealed.openRefusal) {
          throw new AgentSessionRefusalError(revealed.openRefusal)
        }
        await ctx.runtime.publishStructuredAgentSessionTab({
          ...revealed,
          activate: true,
          check,
          selectionCurrent,
          viewerSelection: execution.viewerSelection,
          focusWindow: agentLaunchMovesHostWindow(ctx),
          placement: close?.placement() ?? create?.tabPlacement
        })
        deadline.check()
        if (close) {
          await close.retire()
        }
        deadline.check()
        // Publication is complete; a first new send may already own the ordinary start.
        const starting = await host.openSwitchToChat(sessionId, deadline)
        if (starting.owned) {
          void host.trackSwitchPhysical(sessionId, starting.outcome).catch(() => {})
        } else {
          void starting.outcome.catch(() => {})
        }
        return { status: 'completed', sessionId }
      },
      {
        direction,
        conversationKey: conversation?.commandKey,
        allowUncreated: Boolean(create),
        onRetained:
          direction === 'terminal'
            ? (check) =>
                retainStructuredSwitchSource(
                  ctx.runtime,
                  host,
                  sessionId,
                  execution.invocationId,
                  check
                )
            : undefined
      }
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
    return structuredSessionSwitchFailure(error, sessionId)
  }
}
