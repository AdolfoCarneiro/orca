import { afterEach, expect, it, vi } from 'vitest'
import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession
} from '../../../shared/structured-agent-session-reducer'
import { startStructuredAgentSessionLiveRead } from '../../../shared/structured-agent-session-live-read'
import { AgentSessionSubscribers } from './structured-agent-session-subscribers'
import {
  textRig,
  textBody,
  textIdentity,
  textOptions,
  closeTextJournals
} from '../agent-session-journal/journal-text-test-support'
import { subscriberHistoryReader } from './agent-session-bounded-frames'

afterEach(async () => {
  vi.useRealTimers()
  await closeTextJournals()
})

it.each(['missing-frame', 'bad-baseline', 'missing-baseline'] as const)(
  'hydrates after %s and ignores duplicate suffix delivery',
  async (failure) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const r = await textRig()
    const subscribers = new AgentSessionSubscribers()
    let state = EMPTY_STRUCTURED_AGENT_SESSION
    let dropPatch = false
    let lastPatch: AgentSessionSubscribeEvent | undefined
    const params: { sessionId: string; cursor?: AgentJournalCursor }[] = []
    const read = startStructuredAgentSessionLiveRead({
      sessionId: 'chat',
      getCursor: () => state.cursor,
      readCurrentRequests: async () => {
        throw new Error('unexpected current requests')
      },
      applyEvent: (event) => {
        state = reduceStructuredAgentSession(state, { type: 'event', event })
      },
      applyError: (message) => {
        throw new Error(message)
      },
      onContactLost: () => {},
      onHistoryReadInvalidated: () => {},
      subscribeRetryNow: () => () => {},
      subscribe: async (input, onEvent) => {
        params.push(input)
        return {
          unsubscribe: subscribers.open({
            ...input,
            id: `reader-${params.length}`,
            journal: r.journal,
            fence: 7,
            textPatches: true,
            emit: (event) => {
              if (event.type === 'batch' && event.batch.textPatches) {
                lastPatch = event
                if (dropPatch) {
                  dropPatch = false
                  return
                }
              }
              onEvent(event)
            }
          })
        }
      }
    })
    await Promise.resolve()
    const append = async (baseLength: number, suffix: string) => {
      await r.journal.appendItem(textIdentity, textBody(''), {
        ...textOptions,
        streamText: {
          operation: baseLength === 0 ? 'start' : 'append',
          field: 0,
          baseLength,
          suffix
        }
      })
      subscribers.publish('chat', r.journal)
      await vi.advanceTimersByTimeAsync(48)
    }
    try {
      await append(0, 'hello')
      await append(5, '😀')
      expect(lastPatch).toBeDefined()
      if (!lastPatch) {
        throw new Error('missing suffix')
      }
      const prior = state
      state = reduceStructuredAgentSession(state, { type: 'event', event: lastPatch })
      expect(state.items).toEqual(prior.items)
      if (failure === 'missing-frame') {
        dropPatch = true
        await append(7, 'lost')
        await append(11, 'after')
      } else if (failure === 'bad-baseline') {
        state = {
          ...state,
          items: state.items.map((item) => ({ ...item, body: textBody('broken') }))
        }
        await append(7, 'after')
      } else {
        state = { ...state, items: [] }
        await append(7, 'after')
      }
      expect(state.cursor).toBeNull()
      expect(state.status).toBe('loading')
      await vi.advanceTimersByTimeAsync(750)
      expect(params).toHaveLength(2)
      expect(params[1]).toEqual({ sessionId: 'chat' })
      expect(state.status).toBe('ready')
      expect(state.cursor).toEqual(r.journal.cursor())
      expect(state.items).toEqual(r.journal.snapshot().items)
      await append(failure === 'missing-frame' ? 16 : 12, '!')
      expect(state.items).toEqual(r.journal.snapshot().items)
    } finally {
      read.dispose()
    }
  }
)

it('keeps phone shortening and authoritative corrections on the whole-item path', async () => {
  const r = await textRig()
  const subscribers = new AgentSessionSubscribers()
  let state = EMPTY_STRUCTURED_AGENT_SESSION
  const frames: AgentSessionSubscribeEvent[] = []
  subscribers.open({
    id: 'phone',
    sessionId: 'chat',
    journal: r.journal,
    fence: 7,
    textPatches: true,
    boundedFrames: true,
    emit: (event) => {
      frames.push(event)
      state = reduceStructuredAgentSession(state, { type: 'event', event })
    }
  })
  for (const [baseLength, suffix] of [
    [0, 'a'.repeat(70_000)],
    [70_000, 'b'.repeat(4000)],
    [74_000, 'c'.repeat(10_000)]
  ] as const) {
    await r.journal.appendItem(textIdentity, textBody(''), {
      ...textOptions,
      streamText: { operation: baseLength === 0 ? 'start' : 'append', field: 0, baseLength, suffix }
    })
    subscribers.publish('chat', r.journal)
  }
  expect(state.items[0]?.shortened).toBe(true)
  expect(frames.some((event) => event.type === 'batch' && event.batch.textPatches)).toBe(false)
  await r.journal.appendItem(textIdentity, textBody('corrected'), textOptions)
  subscribers.publish('chat', r.journal)
  expect(state.items).toEqual(
    r.journal
      .snapshot()
      .items.map((item) => subscriberHistoryReader({ boundedFrames: true }).form(item).item)
  )
})
