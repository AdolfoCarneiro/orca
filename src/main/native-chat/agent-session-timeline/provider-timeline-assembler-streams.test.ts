import { measureDeltaSnapshotWork } from '../agent-session-wire/agent-session-delta-work-test-support'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseAgentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { agentJournalTurnBody } from '../../../shared/agent-session-turn-record'
import {
  closeProviderTimelineRigs,
  messageText,
  openProviderTimelineRig,
  openUnboundProviderTimelineAssembler,
  providerItemId,
  providerTurnItemId
} from './provider-timeline-assembler-test-support'

afterEach(async () => {
  await closeProviderTimelineRigs()
  vi.useRealTimers()
})

describe("a stream writes only while its row's turn runs", () => {
  it('stops at the end of its turn, though its next delta was admitted before the end was written', async () => {
    const rig = await openProviderTimelineRig()
    const { assembler, bind, drained } = openUnboundProviderTimelineAssembler(rig.journal)
    assembler.apply({ type: 'turn.open', turn: 't1', at: 1_000 })
    assembler.apply({ type: 'text.delta', item: { id: 'm' }, channel: 'assistant', text: 'Hel' })
    assembler.flush()
    assembler.apply({ type: 'turn.end', turn: 't1', at: 2_000, state: 'completed' })
    // Deferred writes must recheck turn state after bind.
    expect(
      assembler.apply({ type: 'text.delta', item: { id: 'm' }, channel: 'assistant', text: 'lo' })
        .dropped
    ).toBeUndefined()
    assembler.flush()
    await bind()
    await drained()
    expect(await rig.turn('t1')).toMatchObject({ state: 'completed' })
    expect((await rig.row(providerItemId('item', 'm')))?.turnScope).toEqual({
      kind: 'turn',
      turnItemId: providerTurnItemId('t1')
    })
    expect(messageText((await rig.row(providerItemId('item', 'm')))?.body)).toBe('Hel')
  })

  it('writes nothing more once another writer of the journal settled its turn', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'turn.open', turn: 't1', at: 1_000 })
    rig.assembler.apply({
      type: 'text.delta',
      item: { id: 'm' },
      channel: 'assistant',
      text: 'Hel'
    })
    const running = await rig.turn('t1')
    const identity = parseAgentJournalItemKey(providerTurnItemId('t1'))
    if (!running || !identity) {
      throw new Error('the turn row is written')
    }
    // Settle Stop without notifying the assembler.
    await rig.journal.appendItem(
      identity,
      agentJournalTurnBody({ ...running, state: 'interrupted', completedAt: 2_000 }),
      { fence: 1, turnScope: { kind: 'thread' } }
    )
    rig.assembler.apply({ type: 'text.delta', item: { id: 'm' }, channel: 'assistant', text: 'lo' })
    rig.assembler.flush()
    expect(messageText((await rig.row(providerItemId('item', 'm')))?.body)).toBe('Hel')

    expect(rig.assembler.openTurnId).toBeNull()
  })

  it('still takes the provider final full snapshot of a message whose turn settled', async () => {
    const rig = await openProviderTimelineRig()
    rig.assembler.apply({ type: 'turn.open', turn: 't1', at: 1_000 })
    rig.assembler.apply({
      type: 'text.delta',
      item: { id: 'm' },
      channel: 'assistant',
      text: 'Hel'
    })
    rig.assembler.apply({ type: 'turn.end', at: 2_000, state: 'completed' })
    rig.assembler.apply({
      type: 'item.close',
      item: 'm',
      body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Hello.' }] }
    })
    expect(messageText((await rig.row(providerItemId('item', 'm')))?.body)).toBe('Hello.')
  })
})

describe('the open budget counts every provider string a stream keeps', () => {
  it('refuses a stream whose thread alone is past the budget', async () => {
    const rig = await openProviderTimelineRig({ schedule: () => () => {} })
    const thread = 't'.repeat(1024 * 1024 + 1)
    expect(
      rig.assembler.apply({
        type: 'text.delta',
        item: { id: 'm' },
        channel: 'assistant',
        text: 'x',
        join: { thread }
      }).admission
    ).toEqual({ accepted: false, reason: 'failed' })
  })
})

it.each(['close', 'tool', 'flush-dispose', 'next-delta'])(
  'keeps a timer-skipped full tail for the %s barrier',
  async (boundary) => {
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] })
    const r = await openProviderTimelineRig({
      schedule: (run, ms) => {
        const timer = setTimeout(run, ms)
        return () => clearTimeout(timer)
      }
    })
    const delta = (text: string) =>
      r.assembler.apply({ type: 'text.delta', item: { id: 'm' }, channel: 'reasoning', text })
    delta('P')
    vi.advanceTimersByTime(60)
    expect(messageText((await r.row(providerItemId('item', 'm')))?.body)).toBe('P')
    vi.advanceTimersByTime(40)
    delta('T')
    vi.advanceTimersByTime(60)
    expect(messageText((await r.row(providerItemId('item', 'm')))?.body)).toBe('P')
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(40)
    if (boundary === 'next-delta') {
      vi.setSystemTime(100)
      vi.advanceTimersByTime(300)
      delta('U')
      vi.advanceTimersByTime(60)
    } else if (boundary === 'close') {
      r.assembler.apply({ type: 'text.close', item: { id: 'm' } })
    } else if (boundary === 'tool') {
      r.assembler.apply({
        type: 'item.close',
        item: 'tool',
        body: { kind: 'tool-call', name: 'Bash', input: {}, state: 'completed' }
      })
    } else {
      r.assembler.flush()
      r.assembler.dispose()
    }
    expect(messageText((await r.row(providerItemId('item', 'm')))?.body)).toBe(
      boundary === 'next-delta' ? 'PTU' : 'PT'
    )
    vi.advanceTimersByTime(1000)
    expect(vi.getTimerCount()).toBe(0)
    r.assembler.dispose()
  }
)

it('releases actual clean timeline owners linearly on session end, turn end, external Stop and dispose', async () => {
  for (const n of [10, 100]) {
    for (const boundary of ['session', 'turn', 'stop', 'dispose']) {
      const r = await openProviderTimelineRig()
      r.assembler.apply({ type: 'turn.open', turn: 't', at: 1000 })
      for (let i = 0; i < n; i++) {
        expect(
          r.assembler.apply({
            type: 'text.delta',
            item: { id: `m${i}` },
            channel: 'assistant',
            text: 'P'
          }).admission.accepted
        ).toBe(true)
      }
      r.assembler.flush()
      await r.eventSink.written?.()
      if (boundary === 'stop') {
        const turn = await r.turn('t')
        const identity = parseAgentJournalItemKey(providerTurnItemId('t'))
        if (!turn || !identity) {
          throw new Error('running turn required')
        }
        await r.journal.appendItem(
          identity,
          agentJournalTurnBody({ ...turn, state: 'interrupted', completedAt: 2000 }),
          { fence: 1, turnScope: { kind: 'thread' } }
        )
      }
      const meter = measureDeltaSnapshotWork()
      if (boundary === 'dispose') {
        r.assembler.dispose()
      } else {
        const result =
          boundary === 'session'
            ? r.assembler.apply({ type: 'session.ended', verdict: { state: 'unverifiable' } })
            : boundary === 'turn'
              ? r.assembler.apply({ type: 'turn.end', turn: 't', at: 2000, state: 'completed' })
              : r.assembler.apply({ type: 'activity', text: null })
        expect(result.admission.accepted).toBe(true)
      }
      const work = meter.work()
      meter.stop()
      expect(work).toBeLessThanOrEqual(8 * n)
      await r.eventSink.written?.()
      for (let i = 0; i < n; i++) {
        expect(messageText((await r.row(providerItemId('item', `m${i}`)))?.body)).toBe('P')
      }
      if (boundary === 'turn' || boundary === 'stop') {
        expect(await r.turn('t')).toMatchObject({
          state: boundary === 'stop' ? 'interrupted' : 'completed'
        })
      }
      r.assembler.dispose()
    }
  }
})

it('scans retained owners once on a skipped timer, assembles no body, and tears down without timers at N/10N', async () => {
  for (const n of [10, 100]) {
    vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] })
    let callbacks = 0
    const r = await openProviderTimelineRig({
      schedule: (run, ms) => {
        const timer = setTimeout(() => {
          callbacks++
          run()
        }, ms)
        return () => clearTimeout(timer)
      }
    })
    for (let i = 0; i < n; i++) {
      r.assembler.apply({
        type: 'text.delta',
        item: { id: `m${i}` },
        channel: 'assistant',
        text: 'P'
      })
    }
    r.assembler.flush()
    await r.eventSink.written?.()
    r.assembler.apply({
      type: 'text.delta',
      item: { id: 'm0' },
      channel: 'assistant',
      text: ' tail'
    })
    const meter = measureDeltaSnapshotWork()
    const join = vi.spyOn(Array.prototype, 'join')
    vi.advanceTimersByTime(60)
    expect(callbacks).toBe(1)
    expect(
      join.mock.contexts.some(
        (chunks) => Array.isArray(chunks) && chunks.includes('P') && chunks.includes(' tail')
      )
    ).toBe(false)
    join.mockRestore()
    expect(meter.work()).toBeLessThanOrEqual(3 * n)
    meter.stop()
    expect(vi.getTimerCount()).toBe(0)
    expect(messageText((await r.row(providerItemId('item', 'm0')))?.body)).toBe('P')
    r.assembler.flush()
    expect(messageText((await r.row(providerItemId('item', 'm0')))?.body)).toBe('P tail')
    r.assembler.dispose()
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  }
})

it('actual ACP lane flush/dispose saves a skipped tail and session end retains Stop semantics', async () => {
  const { AcpStructuredLane } = await import('../../acp/acp-structured-lane')
  const { GROK_ACP_DIALECT } = await import('../../acp/acp-dialects/grok-dialect')
  const { testEventSinkLogging } =
    await import('../agent-session-wire/structured-agent-session-logger-test-support')
  vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] })
  const r = await openProviderTimelineRig()
  const failed = vi.fn()
  const lane = new AcpStructuredLane({
    sink: r.sink,
    sessionId: 'session-timeline',
    agent: 'grok',
    agentName: 'Grok',
    generation: 'gen-1',
    providerSessionId: 'provider-session-1',
    dialect: GROK_ACP_DIALECT,
    logger: testEventSinkLogging().logger,
    onInputAccepted: () => {},
    onFailed: failed
  })
  lane.apply([
    { type: 'turn.open', turn: 't', at: 1000 },
    { type: 'text.delta', item: { id: 'm' }, channel: 'assistant', text: 'P' }
  ])
  vi.advanceTimersByTime(60)
  await r.eventSink.written?.()
  lane.apply([{ type: 'text.delta', item: { id: 'm' }, channel: 'assistant', text: 'T' }])
  vi.advanceTimersByTime(60)
  expect(messageText((await r.row(providerItemId('item', 'm')))?.body)).toBe('P')
  lane.flush()
  lane.apply([
    { type: 'turn.end', turn: 't', at: 2000, state: 'interrupted' },
    { type: 'session.ended', verdict: { state: 'unverifiable' } }
  ])
  lane.dispose()
  await r.eventSink.written?.()
  expect(messageText((await r.row(providerItemId('item', 'm')))?.body)).toBe('PT')
  expect(await r.turn('t')).toMatchObject({ state: 'interrupted' })
  expect(failed).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})
