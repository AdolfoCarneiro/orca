import type { SessionTabOpenPlacement } from './session-tab-placement'
import type { AgentSessionWireRefusal } from './agent-session-wire'
import { agentSessionRefusalError } from './agent-session-wire-refusals'
import { waitForPromiseWithSignal } from './abort-signal-reason'

export const AGENT_SESSION_SWITCH_HOST_MS = 720_000
export const AGENT_SESSION_SWITCH_CLIENT_MS = 735_000

export type AgentSessionSwitchResult =
  | {
      status: 'completed'
      sessionId: string
      terminal?: string
      sourceRetained?: boolean
    }
  | {
      status: 'refused' | 'uncertain'
      refusal: AgentSessionWireRefusal
      sessionId: string
      failureItemId?: string
    }

/** Expiry revokes new effects; already dispatched owners still reconcile their real outcome. */
export function agentSessionSwitchDeadline(
  now = () => performance.now(),
  budget = AGENT_SESSION_SWITCH_HOST_MS
) {
  let expiresAt = now() + budget
  let dispatched = false
  let delegated = false
  const controller = new AbortController()
  let timer = setTimeout(() => controller.abort(expired()), budget)
  function expired() {
    return agentSessionRefusalError('agent_session_operation_expired', {
      reason: 'operationExpired'
    })
  }
  return {
    signal: controller.signal,
    delegateSend: () => {
      if (controller.signal.aborted) {
        throw expired()
      }
      const dispatchExpiresAt = expiresAt
      if (!dispatched && !delegated) {
        if (now() >= expiresAt) {
          throw expired()
        }
        delegated = true
        clearTimeout(timer)
        // Main now owns unsent expiry; allow its actual-send receipt to cross IPC.
        timer = setTimeout(() => controller.abort(expired()), expiresAt - now() + budget)
      }
      return {
        expiresAt: dispatchExpiresAt,
        responseTimeoutMs: budget,
        ...(dispatched ? { responseExpiresAt: expiresAt } : {})
      }
    },
    beforeSend: (sentAt = now()) => {
      if (controller.signal.aborted || (!dispatched && sentAt >= expiresAt)) {
        throw expired()
      }
      if (dispatched) {
        return
      }
      dispatched = true
      expiresAt = sentAt + budget
      clearTimeout(timer)
      timer = setTimeout(() => controller.abort(expired()), Math.max(0, expiresAt - now()))
      if (now() >= expiresAt) {
        controller.abort(expired())
      }
    },
    revoke: (reason: unknown = expired()) => controller.abort(reason),
    remaining: () => Math.max(0, expiresAt - now()),
    check: () => {
      if (controller.signal.aborted) {
        throw controller.signal.reason
      }
      if (now() >= expiresAt) {
        controller.abort(expired())
        throw controller.signal.reason
      }
    },
    wait: <T>(promise: Promise<T>) => waitForPromiseWithSignal(promise, controller.signal),
    dispose: () => clearTimeout(timer)
  }
}
export type AgentSessionSwitchDeadline = ReturnType<typeof agentSessionSwitchDeadline>

/** In-process authority; never serialize the callbacks as a transport permit. */
export type AgentSessionSwitchAuthority = {
  invocationId: string
  openPlacement?: SessionTabOpenPlacement
  /** View freshness is independent of process authority. */
  selectionCurrent?: () => boolean
  check: () => void
  remaining: () => number
  signal: AbortSignal
  /** Existing acquisition/creation settlement only; logical failure never proves source exit. */
  trackPhysical?: <T>(work: Promise<T>, recover?: () => Promise<void>) => Promise<T>
}

export type SessionSwitchProjection = {
  invocationId: string
  generation: string
  sessionId: string
  tabId: string
  phase: 'prepare' | 'retire' | 'retain'
}
