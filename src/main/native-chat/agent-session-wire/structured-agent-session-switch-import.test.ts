import { mkdtemp, rm, writeFile, appendFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentType } from '../../../shared/agent-status-types'
import { agentSessionSwitchDeadline } from '../../../shared/agent-session-switch-execution'
import {
  claudeProviderHandle,
  codexProviderHandle
} from '../../../shared/agent-session-provider-handle-encoding'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import Database from '../../sqlite/sync-database'
import { claudePromptUuidForSubmission } from '../../claude/structured/claude-structured-session-id'
import { encodePiHistoryClaim } from '../../pi/rpc-history-journal-view'
import { createLegacyProviderTimelineIdentityScheme } from '../agent-session-timeline/provider-timeline-identity'
import { acpNamedTextKey } from '../../acp/acp-turn-messages'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { piHistoryEntryIdentity } from '../../pi/rpc-history-import'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-host-database-test-support'
import { createPiTranscriptCollector } from '../agent-session-journal/journal-pi-active-branch'
import { decodePiTurnLifecycle } from '../transcript-turn-lifecycle'
import {
  captureSwitchStoppedCliTurn,
  catchUpSwitchedCliTranscript
} from './structured-agent-session-switch-import'

vi.mock('../../ai-vault/session-scanner-opencode-sqlite-worker-spawn', async () => {
  const query = await import('../transcript-opencode-sqlite-query')
  return {
    readOpenCodeTranscriptPageViaWorker: async (
      args: Parameters<typeof query.readOpenCodeTranscriptPage>[0]
    ) => query.readOpenCodeTranscriptPage(args),
    readOpenCodeTranscriptSignalViaWorker: async (args: { dbPath: string; sessionId: string }) =>
      query.readOpenCodeTranscriptSignal(args.dbPath, args.sessionId)
  }
})
const journals = createTrackedJournalOpener()
let root: string
let deadline: ReturnType<typeof agentSessionSwitchDeadline>
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-switch-import-'))
  deadline = agentSessionSwitchDeadline()
})
afterEach(async () => {
  deadline.dispose()
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})
function options() {
  return {
    stateDirectory: root,
    identity: {
      sessionId: 'native',
      workspaceId: 'folder',
      hostId: 'local',
      agent: 'codex' as const,
      providerHandle: codexProviderHandle('019aef12-1234-7000-8000-123456789abc')
    }
  }
}
const encode = (rows: unknown[]) => `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`

async function sourceFor(agent: AgentType) {
  const filePath = join(
    root,
    agent === 'opencode' || agent === 'opencode2' ? 'opencode.db' : 'session.jsonl'
  )
  const sessionId = agent === 'pi' ? filePath : 'cli-session'
  const source = { agent, sessionId, filePath }
  if (agent === 'opencode' || agent === 'opencode2') {
    const db = new Database(filePath)
    if (agent === 'opencode') {
      db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY); INSERT INTO session VALUES ('cli-session');
        CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
        CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);`)
      db.prepare('INSERT INTO message VALUES (?, ?, 1, 1, ?)').run(
        'user',
        sessionId,
        JSON.stringify({ role: 'user', time: { created: 1 } })
      )
      db.prepare('INSERT INTO message VALUES (?, ?, 2, 2, ?)').run(
        'reply',
        sessionId,
        JSON.stringify({ role: 'assistant', parentID: 'user', time: { created: 2 } })
      )
      for (const [id, text] of [
        ['user', 'Keep this prompt'],
        ['reply', 'Partial response']
      ]) {
        db.prepare('INSERT INTO part VALUES (?, ?, ?, 1, 1, ?)').run(
          id,
          sessionId,
          id,
          JSON.stringify({ type: 'text', text })
        )
      }
    } else {
      db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY); INSERT INTO session_v2 VALUES ('cli-session');
        CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, data TEXT, time_created INTEGER, time_updated INTEGER);`)
      const insert = db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, 1, 1)')
      insert.run('user', sessionId, 'user', 1, JSON.stringify({ text: 'Keep this prompt' }))
      insert.run(
        'reply',
        sessionId,
        'assistant',
        2,
        JSON.stringify({ content: [{ type: 'text', text: 'Partial response' }] })
      )
    }
    db.close()
    return {
      source,
      finish: async () => {
        const finished = new Database(filePath)
        try {
          if (agent === 'opencode') {
            finished.prepare('UPDATE message SET data = ? WHERE id = ?').run(
              JSON.stringify({
                role: 'assistant',
                parentID: 'user',
                finish: 'stop',
                time: { created: 2, completed: 3 }
              }),
              'reply'
            )
          } else {
            finished
              .prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, 3, 3)')
              .run('end', sessionId, 'idle', 3, JSON.stringify({ outcome: 'succeeded' }))
          }
        } finally {
          finished.close()
        }
      }
    }
  }
  const rows =
    agent === 'claude'
      ? [
          {
            type: 'user',
            uuid: 'user',
            sessionId,
            message: { role: 'user', content: 'Keep this prompt' }
          },
          {
            type: 'assistant',
            uuid: 'reply',
            sessionId,
            message: { role: 'assistant', content: [{ type: 'text', text: 'Partial response' }] }
          }
        ]
      : agent === 'pi'
        ? [
            { type: 'session', version: 3, id: 'header-id' },
            {
              type: 'message',
              id: 'user',
              parentId: null,
              message: { role: 'user', content: 'Keep this prompt' }
            },
            {
              type: 'message',
              id: 'abandoned',
              parentId: 'user',
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'Abandoned answer' }],
                stopReason: 'stop'
              }
            },
            {
              type: 'message',
              id: 'reply',
              parentId: 'user',
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'Partial response' }],
                stopReason: 'toolUse'
              }
            }
          ]
        : [
            {
              type: 'user',
              id: 'user',
              timestamp: '2026-10-28T00:00:00Z',
              content: 'Keep this prompt'
            },
            {
              type: 'assistant',
              id: 'reply',
              timestamp: '2026-10-28T00:00:01Z',
              content: 'Partial response'
            }
          ]
  await writeFile(filePath, encode(rows))
  const events = [
    { type: 'turn_started', session_id: sessionId, turn_number: 1, ts: '2026-10-28T00:00:00Z' }
  ]
  if (agent === 'grok') {
    await writeFile(join(root, 'events.jsonl'), encode(events))
  }
  return {
    source,
    finish: async () => {
      if (agent === 'grok') {
        await writeFile(
          join(root, 'events.jsonl'),
          encode([
            ...events,
            { type: 'turn_ended', outcome: 'completed', ts: '2026-10-28T00:00:02Z' }
          ])
        )
      } else if (agent === 'claude') {
        await writeFile(
          filePath,
          encode([
            ...rows,
            {
              type: 'assistant',
              uuid: 'end',
              sessionId,
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'Final response' }],
                stop_reason: 'end_turn'
              }
            }
          ])
        )
      } else {
        await writeFile(
          filePath,
          encode([
            ...rows,
            {
              type: 'message',
              id: 'end',
              parentId: 'reply',
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'Final response' }],
                stopReason: 'stop'
              }
            }
          ])
        )
      }
    }
  }
}

it.each(['claude', 'pi', 'grok', 'opencode', 'opencode2'] as const)(
  'imports stopped %s through the durable journal, preserves provider completion and deduplicates after reopen',
  async (agent) => {
    const { source, finish } = await sourceFor(agent)
    let journal = await journals.open(options())
    const stopped = await captureSwitchStoppedCliTurn(source, true, deadline)
    expect(stopped).toBeDefined()
    await catchUpSwitchedCliTranscript({ journal, source, fence: 1, deadline, stopped })
    expect(
      journal
        .snapshot()
        .items.filter((item) => item.body.kind === 'turn')
        .map((item) => item.body)
    ).toEqual([expect.objectContaining({ state: 'interrupted' })])
    if (agent === 'pi') {
      expect(
        journal.item(agentJournalItemKey(piHistoryEntryIdentity(source.filePath, 'user')))
      ).not.toBeNull()
      expect(
        journal
          .snapshot()
          .items.some(
            (item) =>
              item.itemId ===
              agentJournalItemKey(piHistoryEntryIdentity(source.filePath, 'abandoned'))
          )
      ).toBe(false)
    }
    const snapshot = journal.snapshot()
    await journal.close()
    journal = await journals.open(options())
    await catchUpSwitchedCliTranscript({ journal, source, fence: 1, deadline, stopped })
    expect(journal.snapshot()).toEqual(snapshot)
    // A different conversation journal sees a completion written before the exact source exited.
    await finish()
    const raced = await journals.open({
      ...options(),
      identity: { ...options().identity, sessionId: 'raced' }
    })
    await catchUpSwitchedCliTranscript({ journal: raced, source, fence: 1, deadline, stopped })
    expect(
      raced
        .snapshot()
        .items.filter((item) => item.body.kind === 'turn')
        .map((item) => item.body)
    ).toEqual([expect.objectContaining({ state: 'completed' })])
  }
)

it('does not infer Interrupted from a historical truncated tail and checks newer work at the commit owner', async () => {
  const { source } = await sourceFor('claude')
  const journal = await journals.open(options())
  await catchUpSwitchedCliTranscript({ journal, source, fence: 1, deadline })
  expect(journal.snapshot().items.some((item) => item.body.kind === 'turn')).toBe(false)
  const stopped = await captureSwitchStoppedCliTurn(source, true, deadline)
  const before = journal.snapshot()
  await expect(
    catchUpSwitchedCliTranscript({
      journal,
      source,
      fence: 1,
      deadline,
      stopped,
      check: () => {
        throw new Error('newer accepted action')
      }
    })
  ).rejects.toThrow('newer accepted action')
  expect(journal.snapshot()).toEqual(before)
})

async function nativePrompt(journal: AgentSessionJournal) {
  await journal.appendSubmission({
    clientMessageId: 'native-prompt',
    payloadFingerprint: 'native-fingerprint',
    fence: 1,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Keep this prompt' }] }
  })
  return agentJournalSubmissionKey('native-prompt')
}

it.each([false, true])(
  'preserves a native Claude submission while importing a later CLI turn (acknowledged=%s)',
  async (acknowledged) => {
    const { source } = await sourceFor('claude')
    const journal = await journals.open(options())
    const native = await nativePrompt(journal)
    const promptUuid = claudePromptUuidForSubmission('native', native)
    if (acknowledged) {
      await journal.resolveDispatch({
        clientMessageId: 'native-prompt',
        fence: 1,
        state: 'accepted',
        providerIdentity: { provider: 'claude', sessionId: source.sessionId, uuid: promptUuid }
      })
    }
    const transcript = await readFile(source.filePath, 'utf8')
    await writeFile(source.filePath, transcript.replace('"uuid":"user"', `"uuid":"${promptUuid}"`))
    const before = journal.snapshot().items
    await catchUpSwitchedCliTranscript({ journal, source, fence: 1, deadline })
    expect(journal.snapshot().items).toEqual(before)
    await appendFile(
      source.filePath,
      encode([
        {
          type: 'user',
          uuid: 'outside-user',
          sessionId: source.sessionId,
          message: { role: 'user', content: 'Outside prompt' }
        },
        {
          type: 'assistant',
          uuid: 'outside-answer',
          sessionId: source.sessionId,
          message: { role: 'assistant', content: [{ type: 'text', text: 'Outside partial' }] }
        }
      ])
    )
    const stopped = await captureSwitchStoppedCliTurn(source, true, deadline)
    await catchUpSwitchedCliTranscript({ journal, source, fence: 1, deadline, stopped })
    expect(journal.item(native)).toEqual(before[0])
    expect(
      journal
        .snapshot()
        .items.filter((item) => item.body.kind === 'message' && item.body.role === 'user')
    ).toHaveLength(2)
  }
)

it.each([
  { oldEntries: 600, payloadBytes: 32, stopReason: 'toolUse', state: 'working' },
  { oldEntries: 6000, payloadBytes: 32, stopReason: 'stop', state: 'completed' },
  { oldEntries: 80, payloadBytes: 16 * 1024, stopReason: 'toolUse', state: 'working' },
  { oldEntries: 80, payloadBytes: 160 * 1024, stopReason: 'stop', state: 'completed' }
])(
  'yields during selected Pi lifecycle replay with $oldEntries old entries of $payloadBytes bytes and a fixed suffix',
  async ({ oldEntries, payloadBytes, stopReason, state }) => {
    const observed: string[] = []
    const emitted: string[] = []
    const slices: { rows: number; bytes: number; emitted: number }[] = []
    const lifecycle: string[] = []
    let rows = 0
    let bytes = 0
    let maxLineBytes = 0
    let pending: ReturnType<typeof setImmediate> | undefined
    const collector = createPiTranscriptCollector(
      (message) => message.id,
      (_line, lineIndex) => ({
        provider: 'legacy',
        agent: 'pi',
        sessionId: 'synthetic-progress-control',
        recordId: String(lineIndex)
      }),
      (line, fallbackId) => {
        observed.push(fallbackId)
        const next = decodePiTurnLifecycle(line, fallbackId)
        if (next) {
          lifecycle.push(next.state)
        }
        rows += 1
        bytes += Buffer.byteLength(line, 'utf8')
        if (!pending) {
          pending = setImmediate(() => {
            slices.push({ rows, bytes, emitted: emitted.length })
            rows = 0
            bytes = 0
            pending = undefined
          })
        }
      }
    )
    let lineIndex = 0
    const record = (entry: Record<string, unknown>) => {
      const line = JSON.stringify(entry)
      maxLineBytes = Math.max(maxLineBytes, Buffer.byteLength(line, 'utf8'))
      collector.record(line, typeof entry.id === 'string' ? entry.id : 'header', lineIndex++)
    }
    try {
      record({ type: 'session', version: 3 })
      record({ type: 'message', id: 'old-user', parentId: null, message: { role: 'user' } })
      record({
        type: 'message',
        id: 'old-answer',
        parentId: 'old-user',
        message: { role: 'assistant', stopReason: 'stop' }
      })
      let parentId = 'old-answer'
      const payload = 'x'.repeat(payloadBytes)
      for (let i = 0; i < oldEntries; i += 1) {
        const id = `old-${i}`
        record({ type: 'custom', id, parentId, data: payload })
        parentId = id
      }
      record({ type: 'custom', id: 'claim', parentId })
      record({
        type: 'compaction',
        id: 'compaction',
        parentId: 'claim',
        firstKeptEntryId: 'old-user',
        summary: 'Kept summary'
      })
      record({
        type: 'message',
        id: 'recent-user',
        parentId: 'compaction',
        message: { role: 'user', content: 'Current prompt' }
      })
      record({
        type: 'message',
        id: 'abandoned-answer',
        parentId: 'recent-user',
        message: { role: 'assistant', stopReason: 'error', content: 'Other branch' }
      })
      record({
        type: 'message',
        id: 'recent-answer',
        parentId: 'recent-user',
        message: { role: 'assistant', stopReason, content: 'Current answer' }
      })
      await collector.project((id) => emitted.push(id), 'claim')
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(observed).toHaveLength(oldEntries + 6)
      expect(observed.slice(-4)).toEqual(['claim', 'compaction', 'recent-user', 'recent-answer'])
      expect(observed).not.toContain('abandoned-answer')
      expect(lifecycle).toEqual(
        state === 'working'
          ? ['working', 'completed', 'working']
          : ['working', 'completed', 'working', 'completed']
      )
      expect(emitted).toEqual(['compaction', 'recent-user', 'recent-answer'])
      expect(slices[0].emitted).toBe(0)
      expect(slices.length).toBeGreaterThan(1)
      expect(Math.max(...slices.map((slice) => slice.rows))).toBeLessThanOrEqual(256)
      expect(Math.max(...slices.map((slice) => slice.bytes))).toBeLessThanOrEqual(
        1024 * 1024 + maxLineBytes
      )
    } finally {
      if (pending) {
        clearImmediate(pending)
      }
      collector.close()
    }
  }
)

it('uses the existing Pi resume claim to import only the selected CLI suffix after native work', async () => {
  const { source } = await sourceFor('pi')
  const journal = await journals.open(options())
  const native = await nativePrompt(journal)
  const before = journal.item(native)
  const cursor = journal.cursor()
  const resumeCursor = encodePiHistoryClaim({
    entry: 'reply',
    epoch: cursor.epoch,
    sequence: cursor.sequence
  })
  await appendFile(
    source.filePath,
    encode([
      {
        type: 'message',
        id: 'outside-user',
        parentId: 'reply',
        message: { role: 'user', content: 'Outside prompt' }
      },
      {
        type: 'message',
        id: 'outside-answer',
        parentId: 'outside-user',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Outside partial' }] }
      }
    ])
  )
  const stopped = await captureSwitchStoppedCliTurn(source, true, deadline)
  await catchUpSwitchedCliTranscript({ journal, source, fence: 1, deadline, stopped, resumeCursor })
  expect(journal.item(native)).toEqual(before)
  expect(
    journal
      .snapshot()
      .items.filter((item) => item.body.kind === 'message' && item.body.role === 'user')
  ).toHaveLength(2)
  expect(
    journal.item(agentJournalItemKey(piHistoryEntryIdentity(source.filePath, 'reply')))
  ).toBeNull()
  expect(
    journal
      .snapshot()
      .items.filter((item) => item.body.kind === 'turn')
      .map((item) => item.body)
  ).toEqual([expect.objectContaining({ state: 'interrupted' })])
})

it.each(['grok', 'opencode', 'opencode2'] as const)(
  'reuses native timeline coverage for %s instead of importing its native prompt and answer again',
  async (agent) => {
    const { source } = await sourceFor(agent)
    const journal = await journals.open(options())
    const native = await nativePrompt(journal)
    const scheme = createLegacyProviderTimelineIdentityScheme({ agent, sessionId: 'native' })
    const turn = {
      namespace: source.sessionId,
      key: { source: 'provider' as const, value: 'prompt:native-prompt' }
    }
    const turnIdentity = scheme.turn(turn)
    await journal.appendLifecycleBatch({
      settlementId: 'native-answer',
      fence: 1,
      mutations: [
        {
          kind: 'item',
          identity: turnIdentity,
          body: {
            kind: 'turn',
            turnId: scheme.turnId(turn),
            state: 'completed',
            userItemId: native
          },
          turnScope: { kind: 'thread' }
        },
        {
          kind: 'item',
          identity: scheme.item({
            namespace: source.sessionId,
            key: { source: 'provider', value: acpNamedTextKey('reply', 'assistant') },
            family: 'item',
            thread: source.sessionId
          }),
          body: {
            kind: 'message',
            role: 'assistant',
            blocks: [{ type: 'text', text: 'Partial response' }]
          },
          turnScope: { kind: 'turn', turnItemId: agentJournalItemKey(turnIdentity) }
        }
      ]
    })
    const before = journal.snapshot().items
    const stopped = await captureSwitchStoppedCliTurn(source, true, deadline)
    await catchUpSwitchedCliTranscript({ journal, source, fence: 1, deadline, stopped })
    expect(journal.snapshot().items).toEqual(before)
  }
)

it('imports a recorded Claude Code disk prefix through switch settlement and preserves completion on a racing final read', async () => {
  const recording = await readFile(
    join(import.meta.dirname, '__fixtures__', 'claude-cli-switch-2.1.302.jsonl'),
    'utf8'
  )
  const rows = recording.trimEnd().split('\n')
  expect(rows).toHaveLength(4)
  const filePath = join(root, 'recorded-claude.jsonl')
  const source = { agent: 'claude' as const, sessionId: JSON.parse(rows[0]!).sessionId, filePath }
  const recordedOptions = {
    ...options(),
    identity: {
      ...options().identity,
      agent: 'claude' as const,
      providerHandle: claudeProviderHandle(source.sessionId)
    }
  }
  // A captured disk prefix at the tool-use frontier; this is not a recording of an actual Stop.
  await writeFile(filePath, `${rows.slice(0, 2).join('\n')}\n`)
  const historical = await journals.open({
    ...recordedOptions,
    identity: { ...recordedOptions.identity, sessionId: 'historical' }
  })
  await catchUpSwitchedCliTranscript({ journal: historical, source, fence: 1, deadline })
  expect(historical.snapshot().items.some((item) => item.body.kind === 'turn')).toBe(false)
  const stopped = await captureSwitchStoppedCliTurn(source, true, deadline)
  expect(stopped).toBeDefined()
  let journal = await journals.open(recordedOptions)
  await catchUpSwitchedCliTranscript({ journal, source, fence: 1, deadline, stopped })
  const snapshot = journal.snapshot()
  expect(
    snapshot.items.filter((item) => item.body.kind === 'turn').map((item) => item.body)
  ).toEqual([expect.objectContaining({ state: 'interrupted' })])
  expect(snapshot.items.some((item) => item.body.kind === 'tool-call')).toBe(true)
  await journal.close()
  journal = await journals.open(recordedOptions)
  await catchUpSwitchedCliTranscript({ journal, source, fence: 1, deadline, stopped })
  expect(journal.snapshot()).toEqual(snapshot)
  await writeFile(filePath, recording)
  const completed = await journals.open({
    ...recordedOptions,
    identity: { ...recordedOptions.identity, sessionId: 'completed' }
  })
  await catchUpSwitchedCliTranscript({ journal: completed, source, fence: 1, deadline, stopped })
  expect(
    completed
      .snapshot()
      .items.filter((item) => item.body.kind === 'turn')
      .map((item) => item.body)
  ).toEqual([expect.objectContaining({ state: 'completed' })])
  const final = completed.snapshot()
  await catchUpSwitchedCliTranscript({ journal: completed, source, fence: 1, deadline, stopped })
  expect(completed.snapshot()).toEqual(final)
})
