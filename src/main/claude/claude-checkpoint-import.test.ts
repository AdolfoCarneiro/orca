import { expect, it, vi } from 'vitest'
import { chat, chatTurn, reply, SID, SESSION } from './claude-transcript-catch-up-test-support'
import { createClaudeJournalTranslator } from './claude-structured-journal-translation'

it.each(['commit', 'stale-new', 'stale', 'cancel', 'refusal'] as const)(
  'orders actual optional transcript import against live debt: %s',
  async (outcome) => {
    const c = await chat('-work', '/work', { maxQueuedOperations: 1 })
    if (outcome !== 'stale-new') {
      await c.live({ text: 'P' })
    }
    const translator = createClaudeJournalTranslator({ sink: c.deferred.sink })
    let serial = 0
    const stream = (event: Record<string, unknown>) =>
      translator.handle({
        type: 'message',
        sessionId: SESSION,
        message: {
          type: 'stream_event',
          uuid: `live-${serial++}`,
          session_id: SID,
          parent_tool_use_id: null,
          event
        }
      })
    stream({ type: 'message_start', message: { id: 'msg_a', role: 'assistant', content: [] } })
    await c.deferred.drained()
    if (outcome !== 'commit') {
      stream({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: outcome === 'stale-new' ? 'P live' : ' live' }
      })
    }
    await c.write([
      ...chatTurn,
      reply('full', 'a1', 'msg_a', { type: 'text', text: 'P live imported' }, 3)
    ])
    const controller = new AbortController()
    const handoff = vi.fn((keys: Iterable<string>) => {
      expect([...keys]).toContain(`claude:${SID}:block%3Amsg_a%3A0`)
      if (outcome === 'cancel') {
        controller.abort()
      }
      if (outcome === 'refusal') {
        const gate = Promise.withResolvers<void>()
        void c.journal.readInOrder(() => {
          void c.journal.readInOrder(() => gate.promise)
        })
        c.deferred.sink.tryAppendItem?.(
          { provider: 'claude', sessionId: SID, uuid: 'blocker' },
          { kind: 'status', tone: 'info', text: 'blocked' },
          { turnScope: { kind: 'thread' } }
        )
        queueMicrotask(() => gate.resolve())
      }
      return translator.transferBeforeImport?.(keys) ?? true
    })
    expect(await c.open('a1', { signal: controller.signal, transferBeforeImport: handoff })).toBe(
      outcome === 'commit'
    )
    expect(handoff).toHaveBeenCalledOnce()
    if (outcome === 'refusal') {
      expect(handoff.mock.results[0]?.value).toBe(false)
    }
    translator.flush()
    await c.deferred.drained()
    stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' tail' } })
    translator.flush()
    await c.deferred.drained()
    expect(c.journal.itemBody(`claude:${SID}:block%3Amsg_a%3A0`)).toMatchObject({
      blocks: [
        {
          type: 'text',
          text: outcome === 'commit' ? 'P live imported tail' : 'P live tail'
        }
      ]
    })
    expect(translator.pendingStreamedBlocks).toBe(0)
    translator.dispose()
  }
)
