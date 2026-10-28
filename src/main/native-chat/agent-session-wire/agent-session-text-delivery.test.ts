import { afterEach, expect, it, vi } from 'vitest'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession
} from '../../../shared/structured-agent-session-reducer'
import { createStructuredAgentSessionEventCoalescer } from '../../../shared/structured-agent-session-coalescer'
import { AgentSessionSubscribers } from './structured-agent-session-subscribers'
import { AgentSessionTextDelivery } from './agent-session-text-delivery'
import {
  textRig,
  textBody,
  textIdentity,
  textOptions,
  closeTextJournals
} from '../agent-session-journal/journal-text-test-support'

afterEach(async () => {
  vi.restoreAllMocks()
  await closeTextJournals()
})

it('bounds actual subscriber serialization at N/10N while preserving every current-client window', async () => {
  const results: {
    mode: string
    n: number
    readers: {
      kind: string
      bytes: number
      frames: number
      maxLagMs: number
      terminalLagMs: number
    }[]
    serializedBytes: number
  }[] = []
  for (const mode of ['whole-path', 'incremental']) {
    const original = JSON.stringify
    const bypass =
      mode === 'whole-path'
        ? vi.spyOn(AgentSessionTextDelivery.prototype, 'tryDeliver').mockReturnValue(false)
        : undefined
    for (const n of [100, 1000]) {
      const r = await textRig()
      let now = 0
      const subscribers = new AgentSessionSubscribers({ now: () => now })
      const readers = ['desktop', 'mobile', 'legacy'].map((kind) => {
        let state = EMPTY_STRUCTURED_AGENT_SESSION
        let bytes = 0,
          frames = 0,
          lastLength = 0,
          lastAt = 0,
          maxLagMs = 0
        const coalescer = createStructuredAgentSessionEventCoalescer((event) => {
          state = reduceStructuredAgentSession(state, { type: 'event', event }, now)
          const block =
            state.items[0]?.body.kind === 'message' ? state.items[0].body.blocks[0] : undefined
          const length = block?.type === 'text' ? block.text.length : 0
          if (length > lastLength) {
            maxLagMs = Math.max(maxLagMs, now - lastAt)
            lastAt = now
            lastLength = length
          }
        }, 0)
        subscribers.open({
          id: kind,
          sessionId: 'chat',
          journal: r.journal,
          fence: 7,
          boundedFrames: kind === 'mobile',
          textPatches: kind !== 'legacy',
          emit: (event) => {
            const serialized = JSON.stringify({ id: 'subscription', ok: true, result: event })
            bytes += Buffer.byteLength(serialized, 'utf8')
            frames++
            const decoded: { result: AgentSessionSubscribeEvent } = JSON.parse(serialized)
            coalescer.push(decoded.result)
            coalescer.flush()
          }
        })
        return {
          kind,
          read: () => state,
          metrics: () => ({ kind, bytes, frames, maxLagMs, terminalLagMs: now - lastAt })
        }
      })
      let serializedBytes = 0
      const stringify = vi.spyOn(JSON, 'stringify').mockImplementation((value, replacer, space) => {
        const serialized = original(value, replacer, space)
        serializedBytes += serialized ? Buffer.byteLength(serialized, 'utf8') : 0
        return serialized
      })
      for (let index = 0; index < n; index++) {
        now += 60
        await r.journal.appendItem(textIdentity, textBody(''), {
          ...textOptions,
          streamText: {
            operation: index === 0 ? 'start' : 'append',
            field: 0,
            baseLength: index * 40,
            suffix: 'x'.repeat(40)
          }
        })
        subscribers.publish('chat', r.journal, { turnId: 'turn', text: 'working' })
        subscribers.publish('chat', r.journal)
        if (mode === 'incremental') {
          for (const reader of readers.filter((reader) => reader.kind !== 'legacy')) {
            expect(reader.read().items[0]?.body).toEqual(textBody('x'.repeat((index + 1) * 40)))
          }
        }
      }
      await r.journal.appendItem(textIdentity, textBody(`${'x'.repeat(n * 40)}!`), textOptions)
      subscribers.publish('chat', r.journal)
      for (const reader of readers) {
        expect(reader.read().items[0]?.body).toEqual(textBody(`${'x'.repeat(n * 40)}!`))
        expect(reader.read().cursor).toEqual(r.journal.cursor())
      }
      stringify.mockRestore()
      results.push({ mode, n, readers: readers.map((reader) => reader.metrics()), serializedBytes })
    }
    bypass?.mockRestore()
  }
  console.log('subscriber-byte-evidence', JSON.stringify(results))
  for (const kind of ['desktop', 'mobile', 'legacy']) {
    const small = results
      .find((result) => result.mode === 'incremental' && result.n === 100)!
      .readers.find((reader) => reader.kind === kind)!
    const large = results
      .find((result) => result.mode === 'incremental' && result.n === 1000)!
      .readers.find((reader) => reader.kind === kind)!
    expect(large.bytes / small.bytes).toBeLessThan(13)
    expect(large.terminalLagMs).toBe(0)
    if (kind !== 'legacy') {
      expect(large.maxLagMs).toBe(60)
    }
  }
  const small = results.find((result) => result.mode === 'incremental' && result.n === 100)!
  const large = results.find((result) => result.mode === 'incremental' && result.n === 1000)!
  expect(large.serializedBytes / small.serializedBytes).toBeLessThan(14)
  expect(
    results.find((result) => result.mode === 'whole-path' && result.n === 1000)!.serializedBytes
  ).toBeGreaterThan(large.serializedBytes * 8)
}, 60_000)

it('flushes withheld legacy text before control delivery and rehydrates resumed readers', async () => {
  const r = await textRig()
  const subscribers = new AgentSessionSubscribers()
  let state = EMPTY_STRUCTURED_AGENT_SESSION
  const frames: AgentSessionSubscribeEvent[] = []
  const close = subscribers.open({
    id: 'old',
    sessionId: 'chat',
    journal: r.journal,
    fence: 7,
    emit: (event) => {
      frames.push(event)
      state = reduceStructuredAgentSession(state, { type: 'event', event })
    }
  })
  for (let index = 0; index < 3; index++) {
    await r.journal.appendItem(textIdentity, textBody(''), {
      ...textOptions,
      streamText: {
        operation: index === 0 ? 'start' : 'append',
        field: 0,
        baseLength: index === 0 ? 0 : 100 + index - 1,
        suffix: index === 0 ? 'x'.repeat(100) : 'y'
      }
    })
    subscribers.publish('chat', r.journal)
  }
  expect(state.cursor?.sequence).toBeLessThan(r.journal.cursor().sequence)
  const cursor = state.cursor!
  close()
  const closeResumed = subscribers.open({
    id: 'resumed',
    sessionId: 'chat',
    journal: r.journal,
    fence: 7,
    cursor,
    textPatches: true,
    emit: (event) => {
      frames.push(event)
      state = reduceStructuredAgentSession(state, { type: 'event', event })
    }
  })
  expect(state.items[0]?.body).toEqual(textBody(`${'x'.repeat(100)}yy`))
  expect(frames.at(-1)?.type === 'batch' && frames.at(-1)).not.toHaveProperty('batch.textPatches')
  closeResumed()
  // Re-open a legacy baseline and withhold another suffix before a lifecycle/control row.
  subscribers.open({
    id: 'old-again',
    sessionId: 'chat',
    journal: r.journal,
    fence: 7,
    emit: (event) => {
      state = reduceStructuredAgentSession(state, { type: 'event', event })
    }
  })
  await r.journal.appendItem(textIdentity, textBody(''), {
    ...textOptions,
    streamText: { operation: 'append', field: 0, baseLength: 102, suffix: 'z' }
  })
  subscribers.publish('chat', r.journal)
  await r.journal.appendItem(
    { provider: 'claude', sessionId: 'provider', uuid: 'control' },
    { kind: 'status', text: 'ended' },
    textOptions
  )
  subscribers.publish('chat', r.journal)
  expect(state.items[0]?.body).toEqual(textBody(`${'x'.repeat(100)}yyz`))
  expect(state.items[1]?.body).toEqual({ kind: 'status', text: 'ended' })
  expect(state.cursor).toEqual(r.journal.cursor())
})
