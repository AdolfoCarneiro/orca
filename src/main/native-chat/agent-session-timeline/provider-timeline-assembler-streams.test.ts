import { afterEach, describe, expect, it, vi } from 'vitest'
import { measureDeltaSnapshotWork } from '../agent-session-wire/agent-session-delta-work-test-support'
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
  it('saves a paused tail at its deadline and closes without losing the next tail', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(0)
    const rig = await openProviderTimelineRig({
      schedule: (run, ms) => {
        const timer = setTimeout(run, ms)
        return () => clearTimeout(timer)
      }
    })
    const delta = (text: string) =>
      rig.assembler.apply({
        type: 'text.delta',
        item: { id: 'm' },
        channel: 'reasoning',
        text
      })
    delta('first')
    vi.advanceTimersByTime(59)
    expect(await rig.row(providerItemId('item', 'm'))).toBeUndefined()
    vi.advanceTimersByTime(1)
    expect(messageText((await rig.row(providerItemId('item', 'm')))?.body)).toBe('first')
    delta(' tail')
    vi.advanceTimersByTime(399)
    expect(messageText((await rig.row(providerItemId('item', 'm')))?.body)).toBe('first')
    vi.advanceTimersByTime(1)
    expect(messageText((await rig.row(providerItemId('item', 'm')))?.body)).toBe('first tail')
    delta(' close')
    rig.assembler.apply({ type: 'text.close', item: { id: 'm' } })
    expect(messageText((await rig.row(providerItemId('item', 'm')))?.body)).toBe('first tail close')
    const revision = (await rig.row(providerItemId('item', 'm')))?.revision
    vi.advanceTimersByTime(1_000)
    expect((await rig.row(providerItemId('item', 'm')))?.revision).toBe(revision)
  })

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
      expect(work).toBeLessThanOrEqual(4 * n)
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

it('executes early and 400ms callbacks on only pending delivery among N/10N clean bodies', async () => {
  vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] })
  const traces: number[][] = []
  for (const n of [10, 100]) {
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
    const join = Array.prototype.join
    let assemblies = 0
    const joining = vi.spyOn(Array.prototype, 'join').mockImplementation(function (
      this: unknown[],
      separator
    ) {
      if (this.includes('P') && this.includes(' tail')) {
        assemblies++
      }
      return join.call(this, separator)
    })
    await vi.advanceTimersByTimeAsync(60)
    expect(callbacks).toBe(1)
    expect(assemblies).toBe(0)
    expect(messageText((await r.row(providerItemId('item', 'm0')))?.body)).toBe('P')
    const early = meter.work()
    meter.reset()
    await vi.advanceTimersByTimeAsync(340)
    expect(callbacks).toBe(2)
    const due = meter.work()
    meter.stop()
    joining.mockRestore()
    await r.eventSink.written?.()
    expect(messageText((await r.row(providerItemId('item', 'm0')))?.body)).toBe('P tail')
    expect(assemblies).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
    traces.push([early, due])
    r.assembler.dispose()
  }
  expect(traces[1]).toEqual(traces[0])
  expect(traces[0].every((work) => work > 0 && work <= 5)).toBe(true)
})
