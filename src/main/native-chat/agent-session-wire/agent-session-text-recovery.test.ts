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

it.each(['before-retry', 'after-retry'] as const)(
  'recovers an opening patch failure when the stale handle resolves %s',
  async (resolution) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const r = await textRig()
    const subscribers = new AgentSessionSubscribers()
    const handles: ReturnType<typeof Promise.withResolvers<{ unsubscribe: () => void }>>[] = []
    const params: { sessionId: string; cursor?: AgentJournalCursor }[] = []
    const closes: ReturnType<typeof vi.fn>[] = []
    const contactClosed: (() => void)[] = []
    let retryNow = (): void => {}
    let state = EMPTY_STRUCTURED_AGENT_SESSION
    const read = startStructuredAgentSessionLiveRead({
      sessionId: 'chat',
      getCursor: () => state.cursor,
      applyEvent: (event) => {
        state = reduceStructuredAgentSession(state, { type: 'event', event })
      },
      applyError: (message) => {
        throw new Error(message)
      },
      readCurrentRequests: async () => {
        throw new Error('unexpected requests')
      },
      onContactLost: () => {},
      onHistoryReadInvalidated: () => {},
      subscribeRetryNow: (retry) => {
        retryNow = retry
        return () => {}
      },
      subscribe: (input, onEvent, _onError, onClose) => {
        params.push(input)
        contactClosed.push(onClose)
        const handle = Promise.withResolvers<{ unsubscribe: () => void }>()
        handles.push(handle)
        closes.push(
          vi.fn(
            subscribers.open({
              ...input,
              id: `opening-${params.length}`,
              journal: r.journal,
              fence: 7,
              textPatches: true,
              emit: onEvent
            })
          )
        )
        return handle.promise
      }
    })
    try {
      await r.stream(0, 'hello', '')
      subscribers.publish('chat', r.journal)
      await vi.advanceTimersByTimeAsync(48)
      state = { ...state, items: [] }
      await r.stream(5, '!', '')
      subscribers.publish('chat', r.journal)
      expect(state.cursor).toBeNull()
      if (resolution === 'before-retry') {
        handles[0].resolve({ unsubscribe: closes[0] })
      }
      await vi.advanceTimersByTimeAsync(750)
      if (resolution === 'after-retry') {
        handles[0].resolve({ unsubscribe: closes[0] })
        await Promise.resolve()
      }
      expect(closes[0]).toHaveBeenCalledOnce()
      expect(params).toEqual([{ sessionId: 'chat' }, { sessionId: 'chat' }])
      if (resolution === 'after-retry') {
        // The stale promise's finally must not retire the newer operation's opening guard.
        contactClosed[1]()
        retryNow()
        expect(params).toHaveLength(2)
      }
      handles[1].resolve({ unsubscribe: closes[1] })
      await Promise.resolve()
      if (resolution === 'after-retry') {
        await vi.advanceTimersByTimeAsync(750)
        expect(params).toHaveLength(3)
        handles[2].resolve({ unsubscribe: closes[2] })
        await Promise.resolve()
      }
      expect(state.cursor).toEqual(r.journal.cursor())
      expect(state.items).toEqual(r.journal.snapshot().items)
    } finally {
      read.dispose()
      closes.forEach((close) => close())
    }
  }
)

it.each(['publish', 'control'] as const)(
  'delivers interleaved shortened revisions before patch cursor advancement and %s/reconnect',
  async (boundary) => {
    const r = await textRig()
    const subscribers = new AgentSessionSubscribers()
    const shortIdentity = { ...textIdentity, uuid: 'short' }
    let state = EMPTY_STRUCTURED_AGENT_SESSION
    const cursors: number[] = []
    let patches = 0
    const emit = (event: AgentSessionSubscribeEvent) => {
      if (event.type === 'end') {
        return
      }
      const cursor = event.type === 'batch' ? event.batch.cursor : event.page.liveCursor
      if (cursor) {
        cursors.push(cursor.sequence)
      }
      if (event.type === 'batch' && event.batch.textPatches) {
        patches++
      }
      state = reduceStructuredAgentSession(state, { type: 'event', event })
    }
    const close = subscribers.open({
      id: 'phone',
      sessionId: 'chat',
      journal: r.journal,
      fence: 7,
      textPatches: true,
      boundedFrames: true,
      emit
    })
    const append = async (long: boolean, baseLength: number, suffix: string) => {
      await r.journal.appendItem(long ? textIdentity : shortIdentity, textBody(''), {
        ...textOptions,
        streamText: {
          operation: baseLength === 0 ? 'start' : 'append',
          field: 0,
          baseLength,
          suffix
        }
      })
      subscribers.publish('chat', r.journal)
    }
    await append(true, 0, 'a'.repeat(100_000))
    await append(false, 0, 'b'.repeat(100))
    await append(true, 100_000, '1')
    await append(true, 100_001, '2')
    expect(state.cursor?.sequence).toBeLessThan(r.journal.cursor().sequence)
    await append(false, 100, '!')
    if (boundary === 'control') {
      await r.journal.appendItem(
        { ...textIdentity, uuid: 'control' },
        { kind: 'status', text: 'ended' },
        textOptions
      )
    }
    subscribers.publish('chat', r.journal)
    const projection = () =>
      r.journal
        .snapshot()
        .items.map((item) => subscriberHistoryReader({ boundedFrames: true }).form(item).item)
    expect(state.items).toEqual(projection())
    expect(state.cursor).toEqual(r.journal.cursor())
    expect(cursors).toEqual([...cursors].sort((a, b) => a - b))
    const cursor = state.cursor!
    close()
    subscribers.open({
      id: 'resumed',
      sessionId: 'chat',
      journal: r.journal,
      fence: 7,
      textPatches: true,
      boundedFrames: true,
      cursor,
      emit
    })
    expect(state.items).toEqual(projection())
    await append(false, 101, '?')
    await append(false, 102, '.')
    expect(state.items).toEqual(projection())
    expect(patches).toBeGreaterThan(0)
    expect(cursors).toEqual([...cursors].sort((a, b) => a - b))
  }
)

it('retires a removed pending item and resumes suffix delivery for another item', async () => {
  const r = await textRig()
  const subscribers = new AgentSessionSubscribers()
  let state = EMPTY_STRUCTURED_AGENT_SESSION
  const frames: AgentSessionSubscribeEvent[] = []
  subscribers.open({
    id: 'phone',
    sessionId: 'chat',
    journal: r.journal,
    fence: 7,
    boundedFrames: true,
    textPatches: true,
    emit: (event) => {
      frames.push(event)
      state = reduceStructuredAgentSession(state, { type: 'event', event })
    }
  })
  for (const [baseLength, suffix] of [
    [0, 'a'.repeat(100_000)],
    [100_000, '1'],
    [100_001, '2']
  ] as const) {
    await r.stream(baseLength, suffix, '')
    subscribers.publish('chat', r.journal)
  }
  expect(state.cursor?.sequence).toBeLessThan(r.journal.cursor().sequence)
  await r.journal.appendTombstone(textIdentity, { fence: 7 })
  subscribers.publish('chat', r.journal)
  expect(state.items).toEqual([])
  const other = { ...textIdentity, uuid: 'other' }
  for (const [baseLength, suffix] of [
    [0, 'hello'],
    [5, '!'],
    [6, '?']
  ] as const) {
    await r.journal.appendItem(other, textBody(''), {
      ...textOptions,
      streamText: { operation: baseLength === 0 ? 'start' : 'append', field: 0, baseLength, suffix }
    })
    subscribers.publish('chat', r.journal)
    expect(state.items).toEqual(r.journal.snapshot().items)
    expect(state.cursor).toEqual(r.journal.cursor())
  }
  expect(frames.filter((event) => event.type === 'batch' && event.batch.textPatches)).toHaveLength(
    2
  )
})
