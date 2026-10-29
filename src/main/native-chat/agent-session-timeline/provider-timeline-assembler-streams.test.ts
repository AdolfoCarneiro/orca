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
