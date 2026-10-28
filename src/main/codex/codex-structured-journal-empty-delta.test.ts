import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { codexProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import {
  createTrackedJournalOpener,
  openTestJournalHostDatabase,
  readTestJournalRows
} from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { replayJournal } from '../native-chat/agent-session-journal/journal-open'
import { parseJournalRow } from '../native-chat/agent-session-journal/journal-row-schema'
import { createDeferredStructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'

const SESSION = 'codex-empty-delta'
const THREAD = 'thread'
const TURN = 'turn'
const journals = createTrackedJournalOpener()
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup()
  }
})

async function session() {
  const root = await mkdtemp(join(tmpdir(), 'orca-codex-empty-delta-'))
  const settings = {
    identity: {
      sessionId: SESSION,
      workspaceId: 'folder',
      hostId: 'local',
      agent: 'codex' as const,
      providerHandle: codexProviderHandle(THREAD)
    },
    stateDirectory: root,
    now: () => 1_000
  }
  const journal = await journals.open(settings)
  const errors = vi.fn()
  const deferred = createDeferredStructuredAgentSessionEventSink({
    sessionId: SESSION,
    logger: { error: errors, warn: vi.fn() }
  })
  deferred.bind({ journal, fence: 1, publish: () => {} })
  const translator = createCodexJournalTranslator({
    sink: deferred.sink,
    sessionId: SESSION,
    primaryThreadId: () => THREAD,
    schedule: () => () => {}
  })
  cleanups.push(async () => {
    translator.dispose()
    deferred.close()
    await journals.closeAll()
    await rm(root, { recursive: true, force: true })
  })
  const notify = (method: string, params: Record<string, unknown>, observedAt = 1_000) =>
    expect(
      translator.handle({
        type: 'notification',
        sessionId: SESSION,
        threadId: THREAD,
        method,
        params: { threadId: THREAD, turnId: TURN, ...params },
        observedAt
      })
    ).toEqual({ accepted: true })
  const drained = async () => {
    expect((await deferred.drained()).ok).toBe(true)
    expect(deferred.state()).toEqual({
      queuedBytes: 0,
      queuedOperations: 0,
      backpressured: false,
      failed: false
    })
    expect(errors).not.toHaveBeenCalled()
  }
  const rows = () =>
    readTestJournalRows(openTestJournalHostDatabase(root).db, SESSION, journal.epoch).map(
      (entry) => {
        const parsed = parseJournalRow(entry.rowJson, true)
        if (!parsed.ok) {
          throw new Error('invalid persisted row')
        }
        return parsed.row
      }
    )
  return { journal, settings, deferred, translator, notify, drained, rows, root }
}

it.each([
  ['assistant', 'item/agentMessage/delta'],
  ['reasoning', 'item/reasoning/textDelta']
] as const)(
  'ignores empty Codex %s windows and still saves later text and completion',
  async (role, method) => {
    const r = await session()
    const delta = (text: string) => {
      r.notify(method, { itemId: 'reply', delta: text })
      r.translator.flush()
    }
    r.notify('turn/started', { turn: { id: TURN } })
    delta('hello')
    await r.drained()
    const initial = r.journal.snapshot().items.find((item) => item.body.kind === 'message')
    if (!initial) {
      throw new Error('missing streamed message')
    }
    const cursor = r.journal.cursor()
    delta('')
    delta('')
    await r.drained()
    expect(r.journal.cursor()).toEqual(cursor)
    expect(r.journal.item(initial.itemId)).toEqual(initial)
    expect(r.journal.textSource(initial.itemId)).toMatchObject({
      length: 5,
      revision: initial.revision
    })

    delta(' world')
    await r.drained()
    expect(r.journal.itemBody(initial.itemId)).toMatchObject({
      kind: 'message',
      role,
      blocks: [{ type: 'text', text: 'hello world' }]
    })
    expect(r.rows().filter((row) => row.kind === 'text-delta')).toEqual([
      expect.objectContaining({
        suffix: ' world',
        baseLength: 5,
        predecessor: initial.revision,
        revision: initial.revision + 1
      })
    ])

    delta('')
    r.notify('turn/completed', { turn: { id: TURN, status: 'completed' } }, 2_000)
    await r.drained()
    expect(r.journal.itemBody(initial.itemId)).toMatchObject({
      kind: 'message',
      role,
      blocks: [{ type: 'text', text: 'hello world' }],
      ...(role === 'reasoning' ? { state: 'completed', completedAt: 2_000 } : {})
    })
    expect(r.journal.item(initial.itemId)?.revision).toBe(initial.revision + 2)
    expect(r.journal.textSource(initial.itemId)).toBeUndefined()
    expect(r.deferred.sink.liveTexts?.()).toEqual([])
    expect(r.journal.snapshot().items).toContainEqual(
      expect.objectContaining({
        body: expect.objectContaining({ kind: 'turn', state: 'completed' })
      })
    )
    const final = r.journal.snapshot().items
    expect(replayJournal(openTestJournalHostDatabase(r.root).db, SESSION)?.damage).toBeNull()
    await r.journal.close()
    const reopened = await journals.open(r.settings)
    expect(reopened.snapshot().items).toEqual(final)
  }
)

it('persists changed metadata on an empty suffix instead of skipping the replacement', async () => {
  const r = await session()
  r.notify('turn/started', { turn: { id: TURN } })
  r.notify('item/reasoning/textDelta', { itemId: 'reply', delta: 'thinking' })
  r.translator.flush()
  await r.drained()
  const source = r.deferred.sink.liveTexts?.()[0]
  const live = source?.live
  if (
    !source ||
    !live ||
    live.body.kind !== 'message' ||
    !source.itemId ||
    source.revision === undefined
  ) {
    throw new Error('missing live reasoning')
  }
  const { itemId, revision } = source
  expect(
    r.deferred.sink.tryAppendStreamedItem?.(
      live.identity,
      { ...live.body, state: 'completed', completedAt: 2_000 },
      {
        ...live.options,
        streamText: { operation: 'append', field: 0, baseLength: source.length, suffix: '' }
      }
    )
  ).toEqual({ accepted: true })
  await r.drained()
  expect(r.journal.item(itemId)).toMatchObject({
    revision: revision + 1,
    body: {
      kind: 'message',
      role: 'reasoning',
      state: 'completed',
      completedAt: 2_000,
      blocks: [{ type: 'text', text: 'thinking' }]
    }
  })
  expect(r.rows().some((row) => row.kind === 'text-delta')).toBe(false)
})
