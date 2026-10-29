import type {
  ClaudeCheckpointDeliveryBudget,
  ClaudeStreamedBlockEnd
} from './claude-checkpoint-input'
import type { AgentJournalTurnScope } from '../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import {
  endedJournalReasoning,
  journalReasoningBody
} from '../native-chat/agent-session-journal/journal-reasoning-row'
import type { AgentSessionDeltaCoalescerDeps } from '../native-chat/agent-session-wire/agent-session-delta-coalescer'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { createClaudeStreamedBlockRegistry } from './claude-streamed-block-identity'
import { createClaudeStreamedTextCheckpoints } from './claude-streamed-text-checkpoints'
import {
  claudeRecord,
  claudeText,
  claudeThinkingIdentity,
  claudeThinkingText,
  type ClaudeMessageEnvelope
} from './claude-structured-item-translation'
import type { ClaudeSubagentLinkageSource } from './claude-subagent-linkage'

function streamScope(frame: Record<string, unknown>): string | null {
  const event = claudeRecord(frame.event)
  const sessionId = claudeText(frame.session_id)
  if (frame.type !== 'stream_event' || event?.type !== 'message_start' || !sessionId) {
    return null
  }
  return `${sessionId}/${claudeText(frame.parent_tool_use_id) ?? ''}`
}

export type ClaudeStreamedThinking = ReturnType<typeof createClaudeStreamedThinking>

/** Keep thinking deltas and their final frame on one row until finalization or turn end. */
export function createClaudeStreamedThinking(deps: {
  deliveryBudget?: ClaudeCheckpointDeliveryBudget
  sink: StructuredAgentSessionEventSink
  producer: ClaudeSubagentLinkageSource
  turnScope: () => AgentJournalTurnScope
  openTurn: (frame: Record<string, unknown>, observedAt: number) => void
  coalesceMs?: number
  schedule?: AgentSessionDeltaCoalescerDeps['schedule']
}) {
  const blocks = createClaudeStreamedBlockRegistry('thinking')
  const open = new Map<string, { scope: string }>()
  const checkpoints = createClaudeStreamedTextCheckpoints({
    sink: deps.sink,
    deliveryBudget: deps.deliveryBudget,
    role: 'reasoning',
    ...(deps.coalesceMs === undefined ? {} : { coalesceMs: deps.coalesceMs }),
    ...(deps.schedule ? { schedule: deps.schedule } : {}),
    producer: deps.producer
  })
  const finish = (ended: ClaudeStreamedBlockEnd, scope?: string, finalTail = false): void => {
    checkpoints.finish(
      ended,
      scope === undefined ? undefined : (key) => open.get(key)?.scope === scope,
      finalTail
    )
    for (const [key, block] of open) {
      if (scope === undefined || block.scope === scope) {
        open.delete(key)
      }
    }
  }

  return {
    observe: (frame: Record<string, unknown>, observedAt: number): boolean => {
      // A new message abandons unfinished blocks in the same stream.
      const restarted = streamScope(frame)
      if (restarted !== null) {
        finish({ completedAt: observedAt }, restarted)
        const sessionId = claudeText(frame.session_id)
        if (sessionId) {
          checkpoints.retire(sessionId, claudeText(frame.parent_tool_use_id), observedAt)
        }
      }
      const delta = blocks.observe(frame, observedAt)
      if (!delta) {
        return false
      }
      deps.openTurn(frame, observedAt)
      const identity = delta.identity
      if (identity.provider === 'claude') {
        open.set(agentJournalItemKey(identity), {
          scope: `${identity.sessionId}/${delta.parentToolUseId ?? ''}`
        })
      }
      checkpoints.append(identity, delta.text, delta.parentToolUseId, {
        turnScope: deps.turnScope(),
        observedAt: delta.startedAt
      })
      return true
    },
    /** Close the streamed row if present; only streaming gives us an observed end time. */
    finalize: (
      envelope: ClaudeMessageEnvelope,
      observedAt: number,
      openTurn: () => void
    ): boolean => {
      if (!envelope.content.some((part) => claudeRecord(part)?.type === 'thinking')) {
        return false
      }
      const streamed = blocks.reconcile(envelope)
      const identity =
        streamed?.identity ?? claudeThinkingIdentity(envelope.sessionId, envelope.uuid)
      const key = agentJournalItemKey(identity)
      // A textless final frame still closes its streamed row.
      const text = claudeThinkingText(envelope) ?? ''
      open.delete(key)
      const body = journalReasoningBody(
        text,
        endedJournalReasoning(streamed ? observedAt : undefined)
      )
      if (body || streamed) {
        openTurn()
      }
      checkpoints.replace(
        identity,
        body ?? undefined,
        envelope.parentToolUseId,
        {
          turnScope: deps.turnScope(),
          lifecycle: true,
          ...(streamed ? { observedAt: streamed.startedAt } : {})
        },
        streamed ? { completedAt: observedAt } : {}
      )
      return body !== null || streamed !== null
    },
    finishOpen: (completedAt: number, finalTail = false): void => {
      finish({ completedAt }, undefined, finalTail)
    },
    flush: checkpoints.flush,
    admit: checkpoints.admit,
    reattribute: checkpoints.reattribute,
    transfer: checkpoints.transfer,
    whenDelivered: checkpoints.whenDelivered,
    finalizeOutput: checkpoints.finalize,
    dispose: (): void => {
      blocks.clear()
      open.clear()
      checkpoints.dispose()
    },
    get pending() {
      return checkpoints.pending
    }
  }
}
