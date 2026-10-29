import { AGENT_SESSION_MAX_STREAMS } from '../native-chat/agent-session-wire/agent-session-delta-coalescer'
import {
  AGENT_SESSION_STREAMED_TEXT_MAX_BYTES,
  AGENT_SESSION_STREAMED_TEXT_TOTAL_MAX_BYTES,
  AGENT_SESSION_STREAMED_TEXT_TRUNCATION_MARKER
} from '../native-chat/agent-session-wire/agent-session-text-prefix'
import type {
  AgentJournalItemIdentity,
  AgentJournalMessageItem
} from '../../shared/agent-session-journal-types'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionItemAppendOptions
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { AgentSessionDeltaCoalescerDeps } from '../native-chat/agent-session-wire/agent-session-delta-coalescer'
import type { ClaudeSubagentLinkageSource } from './claude-subagent-linkage'

export type ClaudeStreamedBlockEnd = { completedAt?: number }
export type ClaudeCheckpointDeliveryBudget = { bytes: number; transfer: () => boolean }
export type ClaudeStreamedTextCheckpointDeps = {
  deliveryBudget?: ClaudeCheckpointDeliveryBudget
  sink: StructuredAgentSessionEventSink
  role: 'assistant' | 'reasoning'
  producer: ClaudeSubagentLinkageSource
  coalesceMs?: number
  schedule?: AgentSessionDeltaCoalescerDeps['schedule']
}
export type Route = {
  identity: AgentJournalItemIdentity
  options: StructuredAgentSessionItemAppendOptions
  parent: string | null
  bytes: number
  truncated: boolean
  lastAccepted?: number
  ended?: ClaudeStreamedBlockEnd
  written?: string
  retired?: boolean
}
export type Debt = {
  chunks: string[]
  bytes: number
  replacement?: AgentJournalMessageItem
  due: number
}

/** Return a UTF8 prefix and its source offset without allocating an encoded copy of the frame. */
export function utf8Prefix(
  text: string,
  offset: number,
  limit: number
): { end: number; bytes: number } {
  let end = offset,
    bytes = 0
  while (end < text.length) {
    const point = text.codePointAt(end) ?? 0
    const size = point < 128 ? 1 : point < 2048 ? 2 : point < 65536 ? 3 : 4
    if (bytes + size > limit) {
      break
    }
    bytes += size
    end += point > 65535 ? 2 : 1
  }
  return { end, bytes }
}

export type HeldClaudeCheckpointFrame = {
  route: Route
  key: string
  text: string
  offset: number
  resolve: () => void
}
export function consumeClaudeCheckpointFrame(
  frame: HeldClaudeCheckpointFrame,
  input: {
    dirty: Map<string, Debt>
    budget: ClaudeCheckpointDeliveryBudget
    owe: (key: string, route: Route) => Debt
    arm: (at: number) => void
  }
): boolean {
  const { dirty, budget, owe, arm } = input
  const { route, key, text } = frame
  while (frame.offset < text.length && !route.truncated) {
    if (
      (!dirty.has(key) && dirty.size >= AGENT_SESSION_MAX_STREAMS) ||
      budget.bytes >= AGENT_SESSION_STREAMED_TEXT_TOTAL_MAX_BYTES
    ) {
      if (!budget.transfer()) {
        return false
      }
    }
    const space = Math.min(
      AGENT_SESSION_STREAMED_TEXT_MAX_BYTES - route.bytes,
      AGENT_SESSION_STREAMED_TEXT_TOTAL_MAX_BYTES - budget.bytes
    )
    if (space === 0 && route.bytes < AGENT_SESSION_STREAMED_TEXT_MAX_BYTES) {
      return false
    }
    const prefix = utf8Prefix(text, frame.offset, space)
    const debt = owe(key, route)
    if (prefix.end > frame.offset) {
      debt.chunks.push(text.slice(frame.offset, prefix.end))
      route.bytes += prefix.bytes
      debt.bytes += prefix.bytes
      budget.bytes += prefix.bytes
      frame.offset = prefix.end
    }
    if (
      frame.offset < text.length &&
      space === AGENT_SESSION_STREAMED_TEXT_MAX_BYTES - (route.bytes - prefix.bytes)
    ) {
      // Marker is bounded metadata slack; previously accepted bytes must never be shortened.
      debt.chunks.push(AGENT_SESSION_STREAMED_TEXT_TRUNCATION_MARKER)
      const markerBytes = Buffer.byteLength(AGENT_SESSION_STREAMED_TEXT_TRUNCATION_MARKER)
      debt.bytes += markerBytes
      budget.bytes += markerBytes
      route.truncated = true
    } else if (frame.offset < text.length && prefix.bytes < space) {
      if (!budget.transfer()) {
        return false
      }
    }
    arm(debt.due)
  }
  return true
}

export function claudeDeliveryBudget(
  text: () => boolean,
  thinking: () => boolean
): ClaudeCheckpointDeliveryBudget {
  return {
    bytes: 0,
    transfer: () => {
      const acceptedText = text()
      const acceptedThinking = thinking()
      return acceptedText && acceptedThinking
    }
  }
}
