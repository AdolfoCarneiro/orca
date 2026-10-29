import { afterEach, expect, it, vi } from 'vitest'
import {
  checkpointJournalRig,
  closeCheckpointTestJournals
} from '../claude/claude-checkpoint-test-support'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { codexItemIdentity, CodexTurnOrdinals } from './codex-structured-item-translation'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'
import { createCodexStructuredNotificationRetry } from './codex-structured-notification-retry'
import type { CodexSession } from './codex-structured-session-state'
import type { CodexAppServerConnection } from './app-server/codex-app-server-connection-types'

afterEach(closeCheckpointTestJournals)

it.each(['drain', 'closed'] as const)(
  'retains the pressure tail and incoming notification until %s without another provider frame',
  async (boundary) => {
    const r = await checkpointJournalRig({
      watermarks: { maxQueuedOperations: 2, lowQueuedOperations: 0, lowQueuedBytes: 0 }
    })
    r.translator.dispose()
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] })
    const translator = createCodexJournalTranslator({
      sink: r.deferred.sink,
      bindPromptItemId: () => {}
    })
    const notify = (method: string, params: unknown) =>
      translator.handle({
        type: 'notification',
        sessionId: 'session',
        threadId: 'thread',
        method,
        params
      })
    vi.advanceTimersByTime(60)
    // Admit each first snapshot through the real queue, without filling it during setup.
    for (let i = 0; i < 256; i++) {
      notify('item/agentMessage/delta', { itemId: `m${i}`, delta: 'P'.repeat(100) })
      translator.flush()
      await r.deferred.drained()
    }
    vi.advanceTimersByTime(40)
    notify('item/agentMessage/delta', { itemId: 'm0', delta: 'T'.repeat(64) })
    vi.advanceTimersByTime(60)
    await r.deferred.drained()
    const oldKey = agentJournalItemKey(
      codexItemIdentity({
        threadId: 'thread',
        turnId: null,
        item: { type: 'agentMessage', id: 'm0' },
        ordinals: new CodexTurnOrdinals()
      })
    )
    expect(oldKey).toBeTruthy()
    const oldest = () => (oldKey ? r.journal.item(oldKey) : null)
    expect(oldest()?.body).toMatchObject({ blocks: [{ type: 'text', text: 'P'.repeat(100) }] })
    vi.advanceTimersByTime(10)
    const gate = Promise.withResolvers<void>()
    await r.journal.readInOrder(() => {
      void r.journal.readInOrder(() => gate.promise)
    })
    expect(
      r.deferred.sink.tryAppendItem?.(
        { provider: 'claude', sessionId: 'block', uuid: 'block' },
        { kind: 'status', tone: 'info', text: 'queued' },
        { turnScope: { kind: 'thread' } }
      )
    ).toEqual({ accepted: true })
    expect(
      r.deferred.sink.tryAppendItem?.(
        { provider: 'claude', sessionId: 'block', uuid: 'block-2' },
        { kind: 'status', tone: 'info', text: 'queued-2' },
        { turnScope: { kind: 'thread' } }
      )
    ).toEqual({ accepted: true })
    const connection: CodexAppServerConnection = {
      pid: undefined,
      closed: false,
      request: async () => null,
      notify: () => {},
      respond: () => {},
      respondWithError: () => {},
      close: async () => true,
      pauseReading: vi.fn(),
      resumeReading: vi.fn()
    }
    const forceCloseUnexpected = vi.fn()
    // SAFETY: the retry owner reads only connection/ended/forceCloseUnexpected; translation below is real.
    const session = { connection, ended: false, forceCloseUnexpected } as CodexSession
    const retries = createCodexStructuredNotificationRetry({
      sessionFor: () => session,
      translate: (_id, _session, method, params) => notify(method, params)
    })
    const incoming = { itemId: 'm256', delta: 'incoming' }
    try {
      expect(retries.handle('session', 'item/agentMessage/delta', incoming)).toEqual({
        accepted: false,
        reason: 'backpressure'
      })
      expect(connection.pauseReading).toHaveBeenCalled()
      expect(
        r.journal
          .snapshot()
          .items.some(
            (item) =>
              item.body.kind === 'message' &&
              item.body.blocks.some((block) => block.type === 'text' && block.text === 'incoming')
          )
      ).toBe(false)
      if (boundary === 'closed') {
        r.deferred.close()
      }
    } finally {
      gate.resolve()
    }
    await r.deferred.drained()
    if (boundary === 'drain') {
      expect(await r.deferred.sink.written?.()).toEqual({ ok: true })
    }
    await vi.advanceTimersByTimeAsync(25)
    if (boundary === 'closed') {
      expect(forceCloseUnexpected).toHaveBeenCalledTimes(1)
    } else {
      await r.deferred.drained()
      const body = oldest()?.body
      expect(
        body?.kind === 'message' && body.blocks[0]?.type === 'text' ? body.blocks[0].text : body
      ).toBe(`${'P'.repeat(100)}${'T'.repeat(64)}`)
      await vi.advanceTimersByTimeAsync(60)
      await r.deferred.drained()
      expect(
        r.journal
          .snapshot()
          .items.find(
            (item) =>
              item.body.kind === 'message' &&
              item.body.blocks.some((block) => block.type === 'text' && block.text === 'incoming')
          )?.body
      ).toMatchObject({ blocks: [{ type: 'text', text: 'incoming' }] })
      expect(forceCloseUnexpected).not.toHaveBeenCalled()
    }
    retries.clear('session', connection)
    translator.dispose()
    expect(vi.getTimerCount()).toBe(0)
  }
)
