import { agentSessionProviderHandleChainHead } from '../../../shared/agent-session-provider-handle'
import { randomUUID } from 'node:crypto'
import { createStructuredAgentSessionOperationId } from '../../../shared/structured-agent-session-mutation'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { agentSessionLeasePossiblyWriting } from '../../../shared/agent-session-lease-adjudication'
import {
  AgentSessionRefusalError,
  agentSessionRefusalError
} from '../../../shared/agent-session-wire-refusals'
import {
  catchUpSwitchedCliTranscript,
  type SwitchStoppedCliTurn
} from './structured-agent-session-switch-import'
import { catchUpStructuredSessionAtRest } from './structured-agent-session-at-rest-catch-up'
import type * as HostTypes from './structured-agent-session-host-types'
import type { AgentSessionSwitchDeadline } from '../../../shared/agent-session-switch-execution'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'
import type { StructuredAgentSessionConversationLifetimeHost } from './structured-agent-session-conversation-lifetime-host'
import type { StructuredAgentSessionConversationLifetime } from './structured-agent-session-conversation-lifetime'
type SwitchSourceContext = Pick<
  StructuredAgentSessionHost,
  'deps' | 'cancel' | 'switchGeneration'
> & {
  now: () => number
  lifetime: Pick<StructuredAgentSessionConversationLifetime, 'conversation' | 'stopAgent'>
  sessions: StructuredAgentSessionConversationLifetimeHost['sessions']
  serialize: StructuredAgentSessionConversationLifetimeHost['serialize']
  subscribers: {
    publish: (
      sessionId: string,
      journal: HostTypes.StructuredAgentSessionHostSession['journal']
    ) => void
  }
}
export function structuredAgentSessionSwitchSource(context: SwitchSourceContext) {
  return {
    captureSwitchWork: (id: string, deadline: AgentSessionSwitchDeadline) => {
      const count = context.deps.store.admittedSendCount(id)
      const command = context.switchGeneration(id)
      return () =>
        !deadline.signal.aborted &&
        deadline.remaining() > 0 &&
        context.deps.store.admittedSendCount(id) === count &&
        context.switchGeneration(id) === command
    },
    stopForSwitch: async (
      sessionId: string,
      caller: HostTypes.StructuredAgentSessionCaller,
      deadline: AgentSessionSwitchDeadline
    ) => {
      deadline.check()
      await context.lifetime.conversation(sessionId)
      deadline.check()
      let child = context.sessions.get(sessionId)?.child ?? null
      let admitted = context.deps.store.admittedSendCount(sessionId)
      let accepted = false
      const command = context.switchGeneration(sessionId)
      const record = context.deps.store.getRecord(sessionId)
      if (!record) {
        throw agentSessionRefusalError('agent_session_identity_required', {
          reason: 'recordMissing'
        })
      }
      let settleWorker: ((proven: boolean) => void) | undefined
      try {
        settleWorker = context.deps.captureSessionSwitchStop?.(sessionId)
      } catch {
        context.deps.logger.warn('capturing worker Stop failed', {
          scope: 'session-switch',
          sessionId
        })
      }
      let proven = false
      try {
        const answer = await context.cancel(caller, {
          envelope: {
            sessionId,
            clientOperationId: createStructuredAgentSessionOperationId(randomUUID, context.now()),
            expectedRuntimeFence: record.lease.runtimeFence,
            payloadFingerprint: computeAgentSessionPayloadFingerprint({
              method: 'agentSession.cancel',
              sessionId,
              fields: {}
            })
          },
          onAccepted: (captured) => {
            child = captured
            admitted = context.deps.store.admittedSendCount(sessionId)
            accepted = true
          },
          waitForShutdown: true
        })
        if (!answer.ok) {
          throw new AgentSessionRefusalError(answer.refusal)
        }
        await context.serialize(sessionId, async () => {
          const current = context.sessions.get(sessionId)?.child
          if (
            context.deps.store.admittedSendCount(sessionId) !== admitted ||
            (current && current !== child)
          ) {
            throw agentSessionRefusalError('agent_session_operation_invalid', {
              reason: 'messagesUnsettled'
            })
          }
          if (current) {
            try {
              await context.lifetime.stopAgent(
                sessionId,
                accepted ? { recorded: 'user-stop' } : { cause: 'user-close' }
              )
            } catch {
              context.deps.logger.warn('switch source exit was not confirmed', {
                scope: 'session-switch',
                sessionId,
                source: 'chat',
                exactChild: true
              })
              throw agentSessionRefusalError('agent_session_ownership_unknown', {
                reason: 'ownerUnproven'
              })
            }
          }
          const lease = context.deps.store.getRecord(sessionId)?.lease
          if (!lease || agentSessionLeasePossiblyWriting(lease)) {
            throw agentSessionRefusalError('agent_session_ownership_unknown', {
              reason: 'ownerUnproven'
            })
          }
        })
        proven = true
      } finally {
        try {
          settleWorker?.(proven)
        } catch {
          context.deps.logger.warn('settling worker Stop failed', {
            scope: 'session-switch',
            sessionId,
            proven
          })
        }
      }

      return () =>
        !deadline.signal.aborted &&
        deadline.remaining() > 0 &&
        context.deps.store.admittedSendCount(sessionId) === admitted &&
        context.switchGeneration(sessionId) === command
    },
    refreshSwitchTranscript: async (
      sessionId: string,
      source: {
        sessionId: string
        filePath: string
        agent?: HostTypes.StructuredAgentSessionHostSession['params']['agent']
      },
      deadline: AgentSessionSwitchDeadline,
      stopped?: SwitchStoppedCliTurn,
      check: () => void = deadline.check
    ) => {
      const session = await context.lifetime.conversation(sessionId)
      const transcript = { ...source, agent: source.agent ?? session.params.agent }
      if (transcript.agent === 'codex') {
        await catchUpStructuredSessionAtRest({
          journal: session.journal,
          threadId: source.sessionId,
          filePath: source.filePath,
          fence: context.deps.store.getRecord(sessionId)?.lease.runtimeFence ?? 0,
          deadline,
          stoppedTurnId: stopped?.turnId,
          check
        })
      }
      await catchUpSwitchedCliTranscript({
        journal: session.journal,
        source: transcript,
        resumeCursor: agentSessionProviderHandleChainHead(
          context.deps.store.getRecord(sessionId)?.providerHandleChain ?? []
        )?.handle.resumeCursor,
        fence: context.deps.store.getRecord(sessionId)?.lease.runtimeFence ?? 0,
        deadline,
        stopped,
        check
      })
      context.subscribers.publish(sessionId, session.journal)
    }
  }
}
