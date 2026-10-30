// Republish an existing host-owned record's tab for history entries holding only session id; unpublished tabs disappear on sync.
// Unlike ensure, read workspace/provider from host state so callers cannot redirect publication.

import {
  agentSessionRefusalFromReference,
  isAgentSessionRefusalError,
  isAgentSessionWireRefusalCode
} from '../../../../shared/agent-session-wire'
import type { StructuredAgentSessionReveal } from '../../../native-chat/agent-session-wire/structured-agent-session-host-types'
import { refuseAgentSessionMutation } from '../../../native-chat/agent-session-wire/structured-agent-session-mutation-admission'
import { defineMethod } from '../core'
import {
  ensureStructuredHostInstalled,
  requireStructuredCapability,
  requireStructuredAgentAudience,
  requireStructuredHost
} from './structured-agent-session-gate'
import { RevealParams } from './structured-agent-session-schemas'

export const STRUCTURED_AGENT_SESSION_REVEAL_METHODS = [
  defineMethod({
    name: 'agentSession.reveal',
    permission: 'workspace',
    params: RevealParams,
    handler: async (params, ctx) => {
      const caller = params.navigation === 'caller' ? ctx.caller : undefined
      if (params.navigation === 'caller' && caller?.kind !== 'paired-device') {
        throw new Error('forbidden')
      }
      requireStructuredCapability(ctx)
      await ensureStructuredHostInstalled(ctx)
      let revealed: StructuredAgentSessionReveal
      try {
        const host = requireStructuredHost(ctx)
        requireStructuredAgentAudience(ctx, host.sessionAgent(params.sessionId) ?? '')
        revealed = await host.revealSession(params.sessionId)
      } catch (error) {
        // Translate only typed host refusal codes; genuine faults must not masquerade as missing chats.
        const code = error instanceof Error ? error.message : ''
        if (!isAgentSessionWireRefusalCode(code)) {
          throw error
        }
        return refuseAgentSessionMutation(
          agentSessionRefusalFromReference(
            isAgentSessionRefusalError(error) ? error.refusal : { code },
            code === 'structured_agent_session_unsupported'
              ? 'This host cannot open that chat.'
              : 'This chat is no longer on this host.'
          )
        )
      }
      await ctx.runtime.publishStructuredAgentSessionTab({
        workspaceId: revealed.workspaceId,
        sessionId: revealed.sessionId,
        agent: revealed.agent,
        activate: params.navigation !== 'caller'
      })
      if (
        caller?.kind === 'paired-device' &&
        !ctx.runtime.reopenMobileSessionTabForClient(
          revealed.workspaceId,
          revealed.sessionId,
          caller.deviceId
        )
      ) {
        throw new Error('Could not publish the chat to its caller.')
      }
      // Return named fields only; private journal-open reasons stay on the host.
      const { sessionId, workspaceId, agent, readable } = revealed
      return { ok: true as const, sessionId, workspaceId, agent, readable }
    }
  })
]
