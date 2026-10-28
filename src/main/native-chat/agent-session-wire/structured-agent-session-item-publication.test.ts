import { expect, it, vi } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalMessageItem
} from '../../../shared/agent-session-journal-types'
import { appendCodexItemAndPublish } from '../../codex/codex-structured-journal-sink'
import type { StructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import { appendAgentSessionItemAndPublish } from './structured-agent-session-item-publication'

it.each(['legacy', 'append-refused', 'publish-refused', 'accepted'] as const)(
  'preserves the publication contract on both entry points with %s sinks',
  (mode) => {
    for (const append of [appendCodexItemAndPublish, appendAgentSessionItemAndPublish]) {
      const calls: string[] = []
      const identity = { provider: 'claude', sessionId: 'session', uuid: 'block' } as const
      const body: AgentJournalMessageItem = {
        kind: 'message',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'retained text' }]
      }
      const options = { turnScope: AGENT_JOURNAL_THREAD_SCOPE, observedAt: 12 }
      const refusal = { accepted: false, reason: 'backpressure' } as const
      const sink: StructuredAgentSessionEventSink = {
        appendItem: vi.fn(() => {
          calls.push('append')
        }),
        appendTombstone: vi.fn(),
        publish: () => {
          calls.push('publish')
        }
      }
      if (mode !== 'legacy') {
        sink.tryAppendItem = vi.fn((...args) => {
          if (mode === 'append-refused') {
            calls.push('refused')
            return refusal
          }
          sink.appendItem(...args)
          return { accepted: true }
        })
        sink.tryPublish = () => {
          calls.push('tryPublish')
          return mode === 'publish-refused' ? refusal : { accepted: true }
        }
      }
      const admitted = append(sink, identity, body, options)
      expect(admitted).toEqual(mode.endsWith('refused') ? refusal : { accepted: true })
      expect(calls).toEqual(
        mode === 'legacy'
          ? ['append', 'publish']
          : mode === 'append-refused'
            ? ['refused']
            : ['append', 'tryPublish']
      )
      if (mode === 'append-refused') {
        expect(sink.tryAppendItem).toHaveBeenCalledWith(identity, body, options)
        expect(sink.appendItem).not.toHaveBeenCalled()
      } else {
        expect(sink.appendItem).toHaveBeenCalledWith(identity, body, options)
      }
    }
  }
)
