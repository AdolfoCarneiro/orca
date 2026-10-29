import { withCheckpointTestTransitions } from './claude-checkpoint-test-support'
import { expect, it, vi } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionItemAppendOptions
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { createClaudeJournalTranslator } from './claude-structured-journal-translation'

function recorder() {
  const writes: {
    identity: AgentJournalItemIdentity
    body: AgentJournalItemBody
    options: StructuredAgentSessionItemAppendOptions
  }[] = []
  const sink: StructuredAgentSessionEventSink = {
    appendItem: (identity, body, options) => writes.push({ identity, body, options }),
    appendTombstone: vi.fn(),
    publish: vi.fn()
  }
  const scopeOfProse = (text: string) =>
    writes.findLast(
      (write) =>
        write.body.kind === 'message' &&
        write.body.blocks.some((block) => block.type === 'text' && block.text === text)
    )?.options.turnScope
  return { sink: withCheckpointTestTransitions(sink), writes, scopeOfProse }
}

function frame(message: Record<string, unknown>, startsTurn = false) {
  return {
    type: 'message' as const,
    sessionId: 'orca-session',
    ...(startsTurn ? { startsTurn: true as const } : {}),
    message: { session_id: 'claude-session', ...message }
  }
}

function prose(uuid: string, text: string, parentToolUseId: string | null = null) {
  return frame({
    type: 'assistant',
    uuid,
    parent_tool_use_id: parentToolUseId,
    message: { role: 'assistant', content: [{ type: 'text', text }] }
  })
}

it("scopes the session's and a subagent's rows to the open turn, and a late one to none", () => {
  const { sink, writes, scopeOfProse } = recorder()
  const translator = createClaudeJournalTranslator({ sink, fallbackIdPrefix: 'test' })
  translator.handle(
    frame(
      {
        type: 'user',
        uuid: 'user-1',
        parent_tool_use_id: null,
        message: { role: 'user', content: [{ type: 'text', text: 'go' }] }
      },
      true
    )
  )
  translator.handle(prose('assistant-1', 'Working on it'))
  translator.handle(prose('child-1', 'Child mid-turn', 'toolu_1'))
  translator.handle(frame({ type: 'result', subtype: 'success', uuid: 'result-1', result: 'ok' }))
  translator.handle(prose('child-2', 'Child after the turn', 'toolu_1'))

  const turnRecord = writes.find((write) => write.body.kind === 'turn')
  expect(turnRecord?.options.turnScope).toEqual({ kind: 'thread' })
  const turnKey = expect.stringContaining('turn-lifecycle')
  expect(scopeOfProse('Working on it')).toEqual({ kind: 'turn', turnItemId: turnKey })
  expect(scopeOfProse('Child mid-turn')).toEqual({ kind: 'turn', turnItemId: turnKey })
  expect(scopeOfProse('Child after the turn')).toEqual({ kind: 'thread' })
})

it.each([
  { channel: 'text', settleNext: false },
  { channel: 'thinking', settleNext: false },
  { channel: 'text', settleNext: true },
  { channel: 'thinking', settleNext: true }
] as const)(
  'keeps refused $channel checkpoints in their originating turn, next settlement=$settleNext',
  ({ channel, settleNext }) => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const { sink, writes } = recorder()
    let refuse = true
    sink.tryAppendItem = (identity, body, options) => {
      if (refuse && body.kind === 'message' && body.role !== 'user') {
        return { accepted: false, reason: 'backpressure' }
      }
      sink.appendItem(identity, body, options)
      return { accepted: true }
    }
    const translator = createClaudeJournalTranslator({ sink })
    const frame = (event: Record<string, unknown>, parentToolUseId: string | null = null) =>
      translator.handle({
        type: 'message',
        sessionId: 'session',
        observedAt: Date.now(),
        message: {
          type: 'stream_event',
          uuid: 'frame',
          session_id: 'claude-session',
          parent_tool_use_id: parentToolUseId,
          event
        }
      })
    try {
      if (!settleNext) {
        frame({
          type: 'message_start',
          message: { id: 'original-message', role: 'assistant', content: [] }
        })
      }
      // Also cover older streams that open their turn on the first delta.
      frame(
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: `${channel}_delta`, [channel]: 'original answer' }
        },
        settleNext ? null : 'toolu_1'
      )
      const originalScope = translator.currentTurnScope()
      expect(originalScope.kind).toBe('turn')
      vi.advanceTimersByTime(60)
      translator.handle({
        type: 'message',
        sessionId: 'session',
        message: {
          type: 'system',
          subtype: 'session_state_changed',
          state: 'idle',
          session_id: 'claude-session'
        }
      })
      translator.handle({
        type: 'message',
        sessionId: 'session',
        startsTurn: true,
        message: {
          type: 'user',
          uuid: 'user-next',
          session_id: 'claude-session',
          parent_tool_use_id: null,
          message: { role: 'user', content: [{ type: 'text', text: 'next question' }] }
        }
      })
      expect(translator.currentTurnScope()).not.toEqual(originalScope)
      // A result settling the next turn must not discard the earlier refused obligation.
      if (settleNext) {
        translator.handle({
          type: 'message',
          sessionId: 'session',
          message: {
            type: 'result',
            subtype: 'success',
            uuid: 'result',
            is_error: false,
            session_id: 'claude-session',
            parent_tool_use_id: null
          }
        })
      }
      if (!settleNext) {
        translator.handle({
          type: 'message',
          sessionId: 'session',
          message: {
            type: 'system',
            subtype: 'task_started',
            session_id: 'claude-session',
            task_id: 'task-1',
            tool_use_id: 'toolu_1',
            task_type: 'local_agent',
            subagent_type: 'explorer',
            description: 'Map the lane'
          }
        })
      }
      refuse = false
      vi.advanceTimersByTime(60)
      const answers = writes.filter(
        (row) => row.body.kind === 'message' && row.body.role !== 'user'
      )
      expect(answers).toHaveLength(1)
      expect(answers[0]).toMatchObject({
        body: {
          role: channel === 'text' ? 'assistant' : 'reasoning',
          blocks: [{ type: 'text', text: 'original answer' }]
        },
        options: { turnScope: originalScope, lifecycle: true }
      })
      if (!settleNext) {
        expect(answers[0]?.options).toMatchObject({
          agentId: 'task-1',
          providerParentRef: 'toolu_1'
        })
      }
      if (channel === 'thinking') {
        expect(answers[0]).toMatchObject({
          body: { state: 'completed', completedAt: 60 },
          options: { observedAt: 0 }
        })
      }
      expect(translator.pendingStreamedBlocks).toBe(0)
      const count = writes.length
      vi.advanceTimersByTime(1_000)
      expect(writes).toHaveLength(count)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      translator.dispose()
      vi.useRealTimers()
    }
  }
)
