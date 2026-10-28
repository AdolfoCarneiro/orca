import { afterEach, expect, it } from 'vitest'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession
} from '../../../shared/structured-agent-session-reducer'
import { AgentSessionSubscribers } from './structured-agent-session-subscribers'
import { StructuredAgentSessionCurrentWork } from './structured-agent-session-current-work'
import {
  textRig,
  textBody,
  textIdentityOf,
  textOptions,
  closeTextJournals
} from '../agent-session-journal/journal-text-test-support'

afterEach(closeTextJournals)

it('keeps a legitimately trimmed item off-page while advancing suffix cursors', async () => {
  const r = await textRig()
  const subscribers = new AgentSessionSubscribers()
  let state = EMPTY_STRUCTURED_AGENT_SESSION
  subscribers.open({
    id: 'current',
    sessionId: 'chat',
    journal: r.journal,
    fence: 7,
    textPatches: true,
    emit: (event) => {
      state = reduceStructuredAgentSession(state, { type: 'event', event })
    }
  })
  await r.journal.appendItem(textIdentityOf('old'), textBody(''), {
    ...textOptions,
    streamText: { operation: 'start', field: 0, baseLength: 0, suffix: 'a' }
  })
  subscribers.publish('chat', r.journal)
  await r.journal.appendItem(textIdentityOf('new'), { kind: 'status', text: 'newer' }, textOptions)
  subscribers.publish('chat', r.journal)
  state = { ...state, items: state.items.slice(1), hasOlder: true }
  await r.journal.appendItem(textIdentityOf('old'), textBody(''), {
    ...textOptions,
    streamText: { operation: 'append', field: 0, baseLength: 1, suffix: 'b' }
  })
  subscribers.publish('chat', r.journal)
  expect(state.status).toBe('ready')
  expect(state.items).toHaveLength(1)
  expect(state.items[0]?.body).toEqual({ kind: 'status', text: 'newer' })
  expect(state.cursor).toEqual(r.journal.cursor())
})

it('flushes withheld text when generation ownership ends without another journal row', async () => {
  const r = await textRig()
  let fence: number | null = 7
  const subscribers = new AgentSessionSubscribers({
    readCurrentWork: () => new StructuredAgentSessionCurrentWork(r.journal, fence)
  })
  let state = EMPTY_STRUCTURED_AGENT_SESSION
  subscribers.open({
    id: 'old',
    sessionId: 'chat',
    journal: r.journal,
    fence: 7,
    emit: (event) => {
      state = reduceStructuredAgentSession(state, { type: 'event', event })
    }
  })
  for (const [baseLength, suffix] of [
    [0, 'a'.repeat(100)],
    [100, 'b']
  ] as const) {
    await r.journal.appendItem(textIdentityOf('reply'), textBody(''), {
      ...textOptions,
      streamText: { operation: baseLength === 0 ? 'start' : 'append', field: 0, baseLength, suffix }
    })
    subscribers.publish('chat', r.journal)
  }
  expect(state.cursor?.sequence).toBeLessThan(r.journal.cursor().sequence)
  fence = null
  subscribers.deliverFrames('chat', r.journal)
  expect(state.items[0]?.body).toEqual(textBody(`${'a'.repeat(100)}b`))
  expect(state.cursor).toEqual(r.journal.cursor())
})

it('delivers multiple suffix rows and repeated predecessors in one subscriber window', async () => {
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
      if (event.type === 'batch') {
        patches += event.batch.textPatches?.items.length ?? 0
      }
      state = reduceStructuredAgentSession(state, { type: 'event', event })
    }
  })
  for (const key of ['a', 'b']) {
    await r.journal.appendItem(textIdentityOf(key), textBody('a'), {
      ...textOptions,
      streamText: { operation: 'start', field: 0, baseLength: 0, suffix: 'a' }
    })
    subscribers.publish('chat', r.journal)
  }
  for (const [key, baseLength, suffix] of [
    ['a', 1, 'b'],
    ['b', 1, 'c'],
    ['a', 2, 'd']
  ] as const) {
    await r.journal.appendItem(textIdentityOf(key), textBody(''), {
      ...textOptions,
      streamText: { operation: 'append', field: 0, baseLength, suffix }
    })
  }
  subscribers.publish('chat', r.journal)
  expect(patches).toBe(3)
  expect(state.items).toEqual(r.journal.snapshot().items)
  expect(state.cursor).toEqual(r.journal.cursor())
})

it('keeps legacy growth budgets independent across interleaved streams', async () => {
  const r = await textRig()
  const subscribers = new AgentSessionSubscribers()
  let state = EMPTY_STRUCTURED_AGENT_SESSION
  let longUpdates = 0
  subscribers.open({
    id: 'old',
    sessionId: 'chat',
    journal: r.journal,
    fence: 7,
    emit: (event) => {
      if (event.type === 'batch') {
        longUpdates += event.batch.items.filter((item) => item.itemId.endsWith(':long')).length
      }
      state = reduceStructuredAgentSession(state, { type: 'event', event })
    }
  })
  for (const [key, size] of [
    ['long', 4000],
    ['short', 100]
  ] as const) {
    await r.journal.appendItem(textIdentityOf(key), textBody(''), {
      ...textOptions,
      streamText: { operation: 'start', field: 0, baseLength: 0, suffix: 'a'.repeat(size) }
    })
    subscribers.publish('chat', r.journal)
  }
  longUpdates = 0
  for (let index = 0; index < 100; index++) {
    for (const [key, baseLength, suffix] of [
      ['long', 4000 + index, 'a'],
      ['short', 100 + index * 40, 'x'.repeat(40)]
    ] as const) {
      await r.journal.appendItem(textIdentityOf(key), textBody(''), {
        ...textOptions,
        streamText: { operation: 'append', field: 0, baseLength, suffix }
      })
      subscribers.publish('chat', r.journal)
    }
  }
  expect(longUpdates).toBe(0)
  await r.journal.appendItem(
    textIdentityOf('control'),
    { kind: 'status', text: 'ended' },
    textOptions
  )
  subscribers.publish('chat', r.journal)
  expect(longUpdates).toBe(1)
  expect(state.items).toEqual(r.journal.snapshot().items)
  expect(state.cursor).toEqual(r.journal.cursor())
})

it('replays all withheld streams after transport failure partway through a legacy flush', async () => {
  const r = await textRig()
  const subscribers = new AgentSessionSubscribers()
  let state = EMPTY_STRUCTURED_AGENT_SESSION
  let failuresAfter = Infinity
  subscribers.open({
    id: 'old',
    sessionId: 'chat',
    journal: r.journal,
    fence: 7,
    emit: (event) => {
      if (--failuresAfter === 0) {
        throw new Error('closed transport')
      }
      state = reduceStructuredAgentSession(state, { type: 'event', event })
    }
  })
  for (const key of ['a', 'b']) {
    await r.journal.appendItem(textIdentityOf(key), textBody(''), {
      ...textOptions,
      streamText: { operation: 'start', field: 0, baseLength: 0, suffix: 'a'.repeat(100) }
    })
    subscribers.publish('chat', r.journal)
  }
  const cursor = state.cursor
  if (!cursor) {
    throw new Error('missing baseline')
  }
  for (const key of ['a', 'b']) {
    await r.journal.appendItem(textIdentityOf(key), textBody(''), {
      ...textOptions,
      streamText: { operation: 'append', field: 0, baseLength: 100, suffix: 'b' }
    })
    subscribers.publish('chat', r.journal)
  }
  failuresAfter = 2
  await r.journal.appendItem(
    textIdentityOf('control'),
    { kind: 'status', text: 'ended' },
    textOptions
  )
  subscribers.publish('chat', r.journal)
  expect(state.cursor).toEqual(cursor)
  expect(subscribers.subscriberCountForTests('chat')).toBe(0)
  subscribers.open({
    id: 'retry',
    sessionId: 'chat',
    journal: r.journal,
    fence: 7,
    cursor,
    textPatches: true,
    emit: (event) => {
      state = reduceStructuredAgentSession(state, { type: 'event', event })
    }
  })
  expect(state.items).toEqual(r.journal.snapshot().items)
  expect(state.cursor).toEqual(r.journal.cursor())
})
