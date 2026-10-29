import { afterEach, expect, it, vi } from 'vitest'
import type { AgentJournalItemBody } from '../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { measureDeltaSnapshotWork } from '../native-chat/agent-session-wire/agent-session-delta-work-test-support'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'

afterEach(() => vi.restoreAllMocks())

it('keeps actual patch work constant among clean streams and N completion barriers linear', () => {
  const traces: number[] = []
  for (const n of [10, 100]) {
    const rows = new Map<string, AgentJournalItemBody>()
    const translator = createCodexJournalTranslator({
      sink: {
        appendItem: (identity, body) => {
          rows.set(agentJournalItemKey(identity), body)
        },
        publish: () => {}
      },
      schedule: () => () => {}
    })
    const send = (method: string, params: unknown) =>
      translator.handle({
        type: 'notification',
        sessionId: 's',
        threadId: 'thread',
        method,
        params
      })
    send('turn/started', { turn: { id: 't' } })
    for (let i = 0; i < n; i++) {
      send('item/started', { item: { type: 'agentMessage', id: `m${i}`, text: '' } })
      send('item/agentMessage/delta', { itemId: `m${i}`, delta: 'P' })
    }
    translator.flush()
    const meter = measureDeltaSnapshotWork()
    expect(
      send('item/fileChange/patchUpdated', {
        itemId: 'patch',
        changes: [{ path: 'src/app.ts', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-old\n+new' }]
      }).accepted
    ).toBe(true)
    traces.push(meter.work())
    meter.reset()
    for (let i = 0; i < n; i++) {
      expect(
        send('item/completed', { item: { type: 'agentMessage', id: `m${i}`, text: 'P final' } })
          .accepted
      ).toBe(true)
    }
    const completionWork = meter.work()
    meter.stop()
    expect(completionWork).toBeLessThanOrEqual(4 * n)
    const messages = [...rows.values()].filter(
      (body) => body.kind === 'message' && body.role === 'assistant'
    )
    expect(messages).toHaveLength(n)
    for (const body of messages) {
      expect(body).toMatchObject({ blocks: [{ type: 'text', text: 'P final' }] })
    }
    expect([...rows.values()]).toContainEqual(
      expect.objectContaining({
        kind: 'diff',
        path: 'src/app.ts',
        patch: expect.objectContaining({ head: '@@ -1 +1 @@\n-old\n+new' })
      })
    )
    translator.dispose()
  }
  expect(traces[1]).toBe(traces[0])
  expect(traces[0]).toBeLessThanOrEqual(4)
})
