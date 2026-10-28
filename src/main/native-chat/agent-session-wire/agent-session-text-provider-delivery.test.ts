import { afterEach, expect, it, vi } from 'vitest'
import { createCodexJournalTranslator } from '../../codex/codex-structured-journal-translation'
import { createClaudeJournalTranslator } from '../../claude/claude-structured-journal-translation'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession
} from '../../../shared/structured-agent-session-reducer'
import { textRig, closeTextJournals } from '../agent-session-journal/journal-text-test-support'
import { createDeferredStructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import { AgentSessionSubscribers } from './structured-agent-session-subscribers'

afterEach(closeTextJournals)

it.each(['codex-assistant', 'codex-reasoning', 'claude-text', 'claude-thinking'] as const)(
  'streams suffixes and terminal whole state from %s through the real sink',
  async (mode) => {
    const r = await textRig()
    const subscribers = new AgentSessionSubscribers()
    let state = EMPTY_STRUCTURED_AGENT_SESSION
    let patches = 0
    subscribers.open({
      id: 'current',
      sessionId: 'chat',
      journal: r.journal,
      fence: 7,
      textPatches: true,
      emit: (event) => {
        if (event.type === 'batch' && event.batch.textPatches) {
          patches++
        }
        state = reduceStructuredAgentSession(state, { type: 'event', event })
      }
    })
    const failures = vi.fn()
    const deferred = createDeferredStructuredAgentSessionEventSink({
      sessionId: 'chat',
      logger: { error: failures, warn: vi.fn() }
    })
    deferred.bind({
      journal: r.journal,
      fence: 7,
      publish: (activity) => subscribers.publish('chat', r.journal, activity)
    })
    r.journal.observeCommits(() => {
      queueMicrotask(() => subscribers.publish('chat', r.journal))
    })
    const codex = createCodexJournalTranslator({
      sink: deferred.sink,
      primaryThreadId: () => 'thread',
      schedule: () => () => {}
    })
    const claude = createClaudeJournalTranslator({ sink: deferred.sink, schedule: () => () => {} })
    const notify = (method: string, params: Record<string, unknown>) => {
      expect(
        codex.handle({
          type: 'notification',
          sessionId: 'chat',
          threadId: 'thread',
          observedAt: 100,
          method,
          params: { threadId: 'thread', turnId: 'turn', ...params }
        })
      ).toEqual({ accepted: true })
    }
    const frame = (event: Record<string, unknown>) =>
      claude.handle({
        type: 'message',
        sessionId: 'chat',
        observedAt: 100,
        message: {
          type: 'stream_event',
          session_id: 's',
          uuid: 'frame',
          parent_tool_use_id: null,
          event
        }
      })
    const kind = mode === 'claude-thinking' ? 'thinking' : 'text'
    try {
      if (mode.startsWith('codex')) {
        notify('turn/started', { turn: { id: 'turn' } })
      } else {
        frame({ type: 'message_start', message: { id: 'message', role: 'assistant', content: [] } })
        frame({ type: 'content_block_start', index: 0, content_block: { type: kind, [kind]: '' } })
      }
      for (const text of ['hello', '😀', 'there']) {
        if (mode.startsWith('codex')) {
          notify(
            mode === 'codex-reasoning' ? 'item/reasoning/textDelta' : 'item/agentMessage/delta',
            { itemId: 'reply', delta: text }
          )
          codex.flush()
        } else {
          frame({
            type: 'content_block_delta',
            index: 0,
            delta: { type: `${kind}_delta`, [kind]: text }
          })
          claude.flush()
        }
        expect((await deferred.drained()).ok).toBe(true)
        expect(state.cursor).toEqual(r.journal.cursor())
        expect(state.items).toEqual(r.journal.snapshot().items)
      }
      expect(patches).toBe(2)
      if (mode.startsWith('codex')) {
        notify('turn/completed', { turn: { id: 'turn', status: 'completed' } })
      } else {
        claude.handle({ type: 'ended', sessionId: 'chat', reason: 'exited', observedAt: 200 })
      }
      expect((await deferred.drained()).ok).toBe(true)
      expect(state.items).toEqual(r.journal.snapshot().items)
      expect(failures).not.toHaveBeenCalled()
      if (mode === 'codex-reasoning' || mode === 'claude-thinking') {
        expect(state.items).toContainEqual(
          expect.objectContaining({
            body: expect.objectContaining({
              kind: 'message',
              role: 'reasoning',
              state: 'completed'
            })
          })
        )
      }
    } finally {
      codex.dispose()
      claude.dispose()
      deferred.close()
    }
  }
)
