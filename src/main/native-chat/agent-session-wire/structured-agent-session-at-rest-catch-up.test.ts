import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { agentSessionSwitchDeadline } from '../../../shared/agent-session-switch-execution'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-host-database-test-support'
import { readCodexHistoryJournalView } from '../../codex/codex-history-journal-view'
import {
  captureSwitchStoppedCliTurn,
  catchUpSwitchedCliTranscript
} from './structured-agent-session-switch-import'
import { catchUpStructuredSessionAtRest } from './structured-agent-session-at-rest-catch-up'

const journals = createTrackedJournalOpener()
let root: string
const deadlines: ReturnType<typeof agentSessionSwitchDeadline>[] = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-switch-history-'))
})
afterEach(async () => {
  deadlines.forEach((deadline) => deadline.dispose())
  deadlines.length = 0
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})
const options = () => ({
  stateDirectory: root,
  identity: {
    sessionId: 'native',
    workspaceId: 'folder',
    hostId: 'local',
    agent: 'codex' as const,
    providerHandle: codexProviderHandle('019aef12-1234-7000-8000-123456789abc')
  }
})
const threadId = '019aef12-1234-7000-8000-123456789abc'
type CodexTranscriptFixturePayload =
  | { id: string }
  | { type: 'task_started' | 'task_complete'; turn_id: string }
  | {
      type: 'message'
      role: 'user' | 'assistant'
      content: { type: 'input_text' | 'output_text'; text: string }[]
    }

function transcript(complete: boolean) {
  const row = (type: string, payload: CodexTranscriptFixturePayload) =>
    JSON.stringify({
      timestamp: '2026-10-26T12:00:00Z',
      type,
      payload
    })
  return `${[
    row('session_meta', { id: threadId }),
    row('event_msg', { type: 'task_started', turn_id: 'turn-cli-1' }),
    row('response_item', {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Continue the terminal change' }]
    }),
    row('response_item', {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Implemented and verified.' }]
    }),
    ...(complete ? [row('event_msg', { type: 'task_complete', turn_id: 'turn-cli-1' })] : [])
  ].join('\n')}\n`
}
async function refresh(journal: Awaited<ReturnType<typeof journals.open>>, complete: boolean) {
  const filePath = join(root, 'rollout.jsonl')
  await writeFile(filePath, transcript(complete))
  const deadline = agentSessionSwitchDeadline()
  deadlines.push(deadline)
  return catchUpStructuredSessionAtRest({ journal, threadId, filePath, fence: 1, deadline })
}
it('opens native-founded CLI history without a provider, survives restart and does not duplicate a second return', async () => {
  let journal = await journals.open(options())
  expect(journal.historyOrigin()).toBeNull()
  await refresh(journal, true)
  const snapshot = journal.snapshot()
  expect(snapshot.items.filter((item) => item.body.kind === 'message')).toHaveLength(2)
  expect(readCodexHistoryJournalView(journal, threadId)).toMatchObject({
    unresolvedOrigin: false,
    importedAt: null
  })
  expect(readCodexHistoryJournalView(journal, threadId).known.has('turn-cli-1')).toBe(true)
  await journal.close()
  journal = await journals.open(options())
  await refresh(journal, true)
  expect(journal.snapshot()).toEqual(snapshot)
})
it('never turns a partially written CLI turn into covered history', async () => {
  const journal = await journals.open(options())
  const before = journal.snapshot()
  await expect(refresh(journal, false)).rejects.toMatchObject({
    refusal: { details: { reason: 'messagesUnsettled' } }
  })
  expect(journal.snapshot()).toEqual(before)
  await refresh(journal, true)
  expect(readCodexHistoryJournalView(journal, threadId).known.has('turn-cli-1')).toBe(true)
})

it.each([100, 1000])(
  'imports a real %i-turn Codex corpus with bounded journal passes and idempotent repeat',
  async (count) => {
    const journal = await journals.open(options())
    const filePath = join(root, 'scale-rollout.jsonl')
    const turns = Array.from({ length: count }, (_, i) =>
      transcript(true)
        .split('\n')
        .filter((row) => row && !row.includes('session_meta'))
        .join('\n')
        .replaceAll('turn-cli-1', `turn-cli-${i}`)
    )
    const source = `${transcript(true).split('\n')[0]}\n${turns.join('\n')}\n`
    await writeFile(filePath, source)
    const deadline = agentSessionSwitchDeadline()
    deadlines.push(deadline)
    let scanned = 0
    const visit = journal.visitItemsWithLinkage.bind(journal)
    const visits = vi.spyOn(journal, 'visitItemsWithLinkage').mockImplementation((callback) =>
      visit((...args) => {
        scanned++
        callback(...args)
      })
    )
    const started = performance.now()
    await catchUpStructuredSessionAtRest({ journal, threadId, filePath, fence: 1, deadline })
    const first = journal.snapshot()
    expect(first.items.filter((item) => item.body.kind === 'message')).toHaveLength(2 * count)
    await catchUpStructuredSessionAtRest({ journal, threadId, filePath, fence: 1, deadline })
    expect(journal.snapshot()).toEqual(first)
    expect(visits.mock.calls.length).toBeLessThanOrEqual(3)
    expect(scanned).toBeLessThanOrEqual(12 * count)
    console.info(
      JSON.stringify({
        scanned,
        corpus: 'codex-at-rest',
        turns: count,
        bytes: Buffer.byteLength(source),
        elapsedMs: performance.now() - started
      })
    )
  }
)

it.each([false, true])(
  'commits explicit stopped-turn evidence through import, preserving a terminal verdict=%s',
  async (completedBeforeExit) => {
    let journal = await journals.open(options())
    const filePath = join(root, 'stopped.jsonl')
    const source = { agent: 'codex' as const, sessionId: threadId, filePath }
    const deadline = agentSessionSwitchDeadline()
    deadlines.push(deadline)
    await writeFile(filePath, transcript(false))
    const stopped = await captureSwitchStoppedCliTurn(source, true, deadline)
    expect(stopped?.turnId).toBe('turn-cli-1')
    if (completedBeforeExit) {
      await writeFile(filePath, transcript(true))
    }
    await catchUpStructuredSessionAtRest({
      journal,
      threadId,
      filePath,
      fence: 1,
      deadline,
      stoppedTurnId: stopped?.turnId
    })
    await catchUpSwitchedCliTranscript({ journal, source, fence: 1, deadline, stopped })
    const snapshot = journal.snapshot()
    expect(
      snapshot.items.filter((item) => item.body.kind === 'turn').map((item) => item.body)
    ).toEqual([
      expect.objectContaining({
        turnId: 'turn-cli-1',
        state: completedBeforeExit ? 'completed' : 'interrupted'
      })
    ])
    expect(snapshot.items.filter((item) => item.body.kind === 'message')).toHaveLength(2)
    await journal.close()
    journal = await journals.open(options())
    await catchUpSwitchedCliTranscript({ journal, source, fence: 1, deadline, stopped })
    expect(journal.snapshot()).toEqual(snapshot)
  }
)
