import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createClaudeJournalTranslator } from '../../claude/claude-structured-journal-translation'
import { createCodexJournalTranslator } from '../../codex/codex-structured-journal-translation'
import { readCodexThreadId } from '../../codex/codex-structured-thread-facts'
import { openAcpFixtureRig, readAcpFixture } from '../../acp/acp-timeline-fixture.test-support'
import { GROK_ACP_DIALECT } from '../../acp/acp-dialects/grok-dialect'
import { OPENCODE_ACP_DIALECT } from '../../acp/acp-dialects/opencode-dialect'
import { OMP_ACP_DIALECT } from '../../acp/acp-dialects/omp-dialect'
import { JsonlRpcPeer } from '../../jsonl-rpc/peer'
import { JsonlRpcTimelineLane } from '../../jsonl-rpc/timeline-lane'
import { PiRpcTurns } from '../../pi/rpc-turns'
import {
  closeProviderTimelineRigs,
  openProviderTimelineRig,
  SESSION,
  type ProviderTimelineRig
} from '../agent-session-timeline/provider-timeline-assembler-test-support'

afterEach(closeProviderTimelineRigs)
const record = z.record(z.string(), z.unknown())
function recording(relative: string): unknown[] {
  return readFileSync(join(import.meta.dirname, relative), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
}

function pressure(rig: ProviderTimelineRig): void {
  for (let index = 0; index < 1024; index++) {
    rig.eventSink.appendItem(
      { provider: 'orca', clientMessageId: `queued-${index}` },
      { kind: 'status', tone: 'info', text: `queued-${index}` },
      { lifecycle: true, turnScope: { kind: 'thread' } }
    )
  }
}

async function saved(rig: ProviderTimelineRig): Promise<void> {
  const rows = await rig.rows()
  expect(rows.length).toBeGreaterThan(1024)
  expect(new Set(rows.map((row) => row.itemId)).size).toBe(rows.length)
  const reopened = await rig.reopenJournal()
  expect(reopened.snapshot().items).toEqual(rows)
}

it('saves the recorded Claude batch-lead frames behind live lifecycle writes', async () => {
  const rig = await openProviderTimelineRig()
  const translator = createClaudeJournalTranslator({ sink: rig.eventSink })
  pressure(rig)
  try {
    const shape = z.object({ kind: z.string(), at: z.number(), frame: record.optional() })
    for (const value of recording(
      '../../claude/__fixtures__/claude-lifecycle-capture-batch-lead.jsonl'
    )) {
      const frame = shape.parse(value)
      if (frame.kind === 'frame' && frame.frame) {
        translator.handle({
          type: 'message',
          sessionId: SESSION,
          message: frame.frame,
          observedAt: frame.at
        })
      }
    }
    translator.flush()
    expect(
      (await rig.rows()).some((row) => row.body.kind === 'message' && row.body.role === 'assistant')
    ).toBe(true)
    await saved(rig)
  } finally {
    translator.dispose()
  }
})

it('saves recorded Codex 0.158 control output in order behind live lifecycle writes', async () => {
  const rig = await openProviderTimelineRig()
  const shape = z.object({ case: z.string(), t: z.number(), method: z.string(), params: record })
  const frames = recording('../../codex/__fixtures__/codex-app-server-turn-endings.jsonl')
    .map((value) => shape.parse(value))
    .filter((frame) => frame.case === '0.158.0-control')
  const threadId = readCodexThreadId(frames[0]?.params)
  if (!threadId) {
    throw new Error('recorded primary thread missing')
  }
  const translator = createCodexJournalTranslator({
    sink: rig.eventSink,
    sessionId: SESSION,
    primaryThreadId: () => threadId
  })
  pressure(rig)
  try {
    for (const frame of frames) {
      expect(
        translator.handle({
          type: 'notification',
          sessionId: SESSION,
          threadId,
          method: frame.method,
          params: frame.params,
          observedAt: frame.t
        })
      ).toEqual({ accepted: true })
    }
    translator.flush()
    expect(
      (await rig.rows()).some((row) => row.body.kind === 'turn' && row.body.state === 'completed')
    ).toBe(true)
    await saved(rig)
  } finally {
    translator.dispose()
  }
})

it.each([
  { name: 's1-basic', dialect: GROK_ACP_DIALECT },
  { name: 'opencode-v2-tool', dialect: OPENCODE_ACP_DIALECT },
  { name: 'omp-v17-shell-ok', dialect: OMP_ACP_DIALECT }
])('saves recorded $name output with unchanged journal identities', async ({ name, dialect }) => {
  const fixture = await openAcpFixtureRig(dialect)
  const frames = await readAcpFixture(name)
  pressure(fixture.rig)
  await fixture.feed(frames)
  expect(
    (await fixture.rig.rows()).some(
      (row) => row.body.kind === 'tool-call' || row.body.kind === 'message'
    )
  ).toBe(true)
  await saved(fixture.rig)
})

it('transfers recorded Pi complete tool output from the paused framer before close finalizes its lane', async () => {
  const rig = await openProviderTimelineRig({ agent: 'pi' })
  const shape = z.object({ dir: z.enum(['in', 'out']), raw: z.string() })
  const frames = recording('../../pi/__fixtures__/stop-mid-tool.jsonl').map((value) =>
    shape.parse(value)
  )
  const lane = new JsonlRpcTimelineLane({
    sink: rig.sink,
    sessionId: SESSION,
    agent: 'pi',
    generation: 'pi-generation',
    namespace: 'pi-session',
    onInputAccepted: () => {},
    onFailed: (reason) => {
      throw new Error(reason)
    }
  })
  const turns = new PiRpcTurns({
    lane,
    generation: 'pi-generation',
    send: vi.fn(async () => {}),
    request: vi.fn(async () => ({})),
    settled: () => {},
    failed: (error) => {
      throw error
    },
    idle: () => {}
  })
  const input = new PassThrough()
  const output = new PassThrough()
  let records = 0
  const peer = new JsonlRpcPeer(input, output, {
    onRecord: (frame) => {
      turns.receive(frame)
      records++
      // Later records in this same received chunk must survive transport retirement.
      if (frame.type === 'tool_execution_start') {
        peer.pauseReading()
      }
    },
    onClose: () =>
      lane.finalize({ type: 'session.ended', verdict: { state: 'interrupted', completedAt: 9000 } })
  })
  try {
    pressure(rig)
    const prompt = frames
      .map((frame) => ({
        ...frame,
        value: z.looseObject({ type: z.string() }).parse(JSON.parse(frame.raw))
      }))
      .find((frame) => frame.dir === 'in' && frame.value.type === 'prompt')
    if (!prompt) {
      throw new Error('recorded prompt missing')
    }
    await turns.submit('recorded-send', 100, prompt.value)
    const delivered = frames.filter((frame) => frame.dir === 'out')
    input.write(delivered.map((frame) => `${frame.raw}\n`).join(''))
    expect(records).toBeLessThan(delivered.length)
    peer.close()
    const rows = await rig.rows()
    expect(
      rows.some(
        (row) => row.body.kind === 'tool-call' && row.body.state !== 'running' && row.body.output
      )
    ).toBe(true)
    await saved(rig)
  } finally {
    peer.close()
    turns.end()
    lane.dispose()
  }
})
