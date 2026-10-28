import { afterEach, expect, it, vi } from 'vitest'
import { AcpTimelineTranslator } from '../../acp/acp-timeline-translator'
import { JsonlRpcTimelineLane } from '../../jsonl-rpc/timeline-lane'
import { PiRpcTurns } from '../../pi/rpc-turns'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession
} from '../../../shared/structured-agent-session-reducer'
import {
  closeProviderTimelineRigs,
  messageText,
  openProviderTimelineRig,
  SESSION
} from '../agent-session-timeline/provider-timeline-assembler-test-support'
import { subscriberHistoryReader } from './agent-session-bounded-frames'
import { AgentSessionSubscribers } from './structured-agent-session-subscribers'

const disposals: (() => void)[] = []
afterEach(async () => {
  disposals.splice(0).forEach((dispose) => dispose())
  await closeProviderTimelineRigs()
  vi.useRealTimers()
})

it.each(
  (['acp-assistant', 'acp-reasoning', 'pi-assistant', 'pi-reasoning'] as const).flatMap((mode) =>
    [4000, 100_000].map((initialLength) => ({ mode, initialLength }))
  )
)(
  'preserves each 60ms window and paused suffix from $mode ingress at $initialLength for old/current readers',
  async ({ mode, initialLength }) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.setSystemTime(0)
    const agent = mode.startsWith('pi') ? 'pi' : 'grok'
    const reasoning = mode.endsWith('reasoning')
    const rig = await openProviderTimelineRig({ agent, schedule: undefined }, { agent })
    const subscribers = new AgentSessionSubscribers()
    const readers = [false, true].flatMap((boundedFrames) =>
      [false, true].map((textPatches) => {
        let state = EMPTY_STRUCTURED_AGENT_SESSION
        let lastRevision = -1
        const seen: { text: string; at: number }[] = []
        const cursors: number[] = []
        const terminalRevisions: number[] = []
        const close = subscribers.open({
          id: `${boundedFrames}-${textPatches}`,
          sessionId: SESSION,
          journal: rig.journal,
          fence: 1,
          boundedFrames,
          textPatches,
          emit: (event) => {
            state = reduceStructuredAgentSession(state, { type: 'event', event })
            const text = state.items.map((item) => messageText(item.body) ?? '').join('')
            const revision = state.items.find((item) => item.body.kind === 'message')?.revision ?? 0
            if (state.latestTurn?.turn.state === 'completed') {
              terminalRevisions.push(revision)
            }
            if (lastRevision !== revision) {
              seen.push({ text, at: Date.now() })
            }
            lastRevision = revision
            if (state.cursor) {
              cursors.push(state.cursor.sequence)
            }
          }
        })
        disposals.push(close)
        return { boundedFrames, textPatches, seen, cursors, terminalRevisions, read: () => state }
      })
    )
    rig.journal.observeCommits(() => {
      queueMicrotask(() => subscribers.publish(SESSION, rig.journal))
    })
    const failures = vi.fn()
    const lane = new JsonlRpcTimelineLane({
      sink: rig.sink,
      sessionId: SESSION,
      agent,
      generation: 'cadence',
      namespace: 'provider',
      pauseReading: () => {},
      resumeReading: () => {},
      onInputAccepted: () => {},
      onFailed: failures
    })
    const turns = new PiRpcTurns({
      lane,
      generation: 'cadence',
      send: async () => {},
      request: async () => ({
        sessionFile: '/host/session.jsonl',
        isStreaming: false,
        isCompacting: false,
        pendingMessageCount: 0
      }),
      settled: () => {},
      idle: () => {},
      failed: failures
    })
    const acp = new AcpTimelineTranslator({ sessionId: 'provider' })
    disposals.push(() => {
      turns.end()
      lane.dispose()
      acp.dispose()
      rig.assembler.dispose()
    })
    const applyAcp = (events: ReturnType<AcpTimelineTranslator['notification']>) => {
      for (const event of events) {
        expect(rig.assembler.apply(event).admission.accepted).toBe(true)
      }
    }
    if (agent === 'pi') {
      turns.receive({ type: 'agent_start' })
      turns.receive({ type: 'message_start', message: { role: 'assistant', content: [] } })
    } else {
      applyAcp(acp.openPrompt('send', 0).events)
    }
    const delta = (text: string) => {
      if (agent === 'pi') {
        turns.receive({
          type: 'message_update',
          message: { role: 'assistant', content: [] },
          assistantMessageEvent: {
            type: reasoning ? 'thinking_delta' : 'text_delta',
            contentIndex: 0,
            delta: text
          }
        })
      } else {
        applyAcp(
          acp.notification(
            'session/update',
            {
              sessionId: 'provider',
              update: {
                sessionUpdate: reasoning ? 'agent_thought_chunk' : 'agent_message_chunk',
                content: { type: 'text', text }
              }
            },
            Date.now()
          )
        )
      }
    }
    const projection = (boundedFrames: boolean) =>
      rig.journal
        .snapshot()
        .items.map((item) => subscriberHistoryReader({ boundedFrames }).form(item).item)
    let text = ''
    for (const suffix of ['x'.repeat(initialLength), 'a', '😀', 'b']) {
      const previous = readers.map((reader) => reader.seen.at(-1))
      delta(suffix)
      await vi.advanceTimersByTimeAsync(59)
      await rig.rows()
      readers.forEach((reader, index) => expect(reader.seen.at(-1)).toEqual(previous[index]))
      text += suffix
      await vi.advanceTimersByTimeAsync(1)
      await rig.rows()
      for (const reader of readers) {
        expect(reader.seen.at(-1)?.at).toBe(Date.now())
        expect(reader.read().cursor).toEqual(rig.journal.cursor())
        expect(reader.read().items).toEqual(projection(reader.boundedFrames))
      }
    }
    await vi.advanceTimersByTimeAsync(6000)
    await rig.rows()
    for (const reader of readers) {
      expect(reader.read().items).toEqual(projection(reader.boundedFrames))
    }
    // A barrier flushes the final partial window before the turn settles.
    delta('tail')
    text += 'tail'
    if (agent === 'pi') {
      turns.receive({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [reasoning ? { type: 'thinking', thinking: text } : { type: 'text', text }]
        }
      })
      turns.receive({ type: 'agent_end' })
      turns.receive({ type: 'agent_settled' })
    } else {
      applyAcp(acp.promptResult('send', { stopReason: 'end_turn' }, Date.now()))
    }
    await rig.rows()
    expect(failures).not.toHaveBeenCalled()
    expect((await rig.turns())[0]?.outcome).toBe('success')
    for (const reader of readers) {
      expect(reader.seen.at(-1)?.at).toBe(Date.now())
      expect(reader.read().items).toEqual(projection(reader.boundedFrames))
      expect(reader.cursors).toEqual([...reader.cursors].sort((a, b) => a - b))
      const finalRevision = rig.journal
        .snapshot()
        .items.find((item) => item.body.kind === 'message')?.revision
      expect(reader.terminalRevisions.length).toBeGreaterThan(0)
      expect(reader.terminalRevisions.every((revision) => revision === finalRevision)).toBe(true)
      console.log(
        'provider-cadence-evidence',
        JSON.stringify({
          mode,
          initialLength,
          bounded: reader.boundedFrames,
          patches: reader.textPatches,
          windows: reader.seen.map(({ text, at }) => ({ length: text.length, at }))
        })
      )
    }
  }
)
