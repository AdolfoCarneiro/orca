import { DaemonConnectionLostError, DaemonRequestTimeoutError } from '../../../daemon/daemon-errors'
import { isAgentSessionOperationOutcomeUnknown } from '../../runtime-agent-launch-resolution'
import type { AgentSessionSwitchResult } from '../../../../shared/agent-session-switch-execution'
import {
  agentSessionRefusalError,
  isAgentSessionRefusalError,
  refuseUnclassified
} from '../../../../shared/agent-session-wire-refusals'
export function structuredSessionSwitchFailure(
  error: unknown,
  sessionId: string
): AgentSessionSwitchResult {
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
