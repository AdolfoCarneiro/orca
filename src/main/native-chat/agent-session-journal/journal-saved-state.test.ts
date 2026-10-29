import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalMessageItem,
  type AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../shared/agent-session-journal-item-key'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'
import {
  applyJournalRow,
  createJournalReducerState,
  MAX_JOURNAL_APPLIED_SETTLEMENT_IDS,
  renderJournalState,
  type JournalReducerState
} from './journal-reducer'
import { replayJournal, restoreJournal } from './journal-open'
import {
  createTrackedJournalOpener,
  openTestJournalHostDatabase,
  publishTestJournalEpoch,
  insertTestJournalRow,
  insertTestJournalRowJson,
  liveTestJournalRows
} from './journal-host-database-test-support'
import {
  readJournalSavedState,
  saveJournalState,
  sweepJournalSavedState
} from './journal-saved-state'
import { backfillJournalState } from './journal-state-backfill'
import { JournalStopMarks } from './journal-stop-marks'
import { readAgentSessionHistory } from '../agent-session-wire/agent-session-history-page'
import { structuredAgentSessionStopping } from '../agent-session-wire/structured-agent-session-stopping'
import { failLoadOnUnloadableJournal } from './journal-open-failure'
import type { JournalRow } from './journal-row-schema'
import type { JournalHostDatabase } from './journal-host-database'

const identity: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'workspace-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: codexProviderHandle('thread-1')
}
const providerHandle = { kind: 'codex', threadId: 'thread-1' } as const
const epoch = 'epoch-1'
const text = (
  value: string,
  role: 'user' | 'assistant' = 'assistant'
): AgentJournalMessageItem => ({
  kind: 'message',
  role,
  blocks: [{ type: 'text', text: value }]
})
const base = (seq: number) => ({ v: 4, epoch, seq, fence: 1, ts: 1_000 + seq })
const itemId = (ordinal: number) =>
  agentJournalItemKey({ provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal })
let root: string
let database: JournalHostDatabase
const journals = createTrackedJournalOpener()

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-saved-state-'))
  database = openTestJournalHostDatabase(root)
})
afterEach(async () => {
  await journals.closeAll()
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

function write(rows: readonly JournalRow[]): JournalReducerState {
  const state = createJournalReducerState(identity.sessionId, epoch)
  database.transaction((db) => {
    publishTestJournalEpoch(db, identity.sessionId, epoch)
    for (const row of rows) {
      insertTestJournalRow(db, identity.sessionId, row)
      applyJournalRow(state, row)
    }
  })
  return state
}

function requireState(state: JournalReducerState | null | undefined): JournalReducerState {
  expect(state).toBeTruthy()
  if (!state) {
    throw new Error('missing journal state')
  }
  return state
}

function expectSameState(actual: JournalReducerState, expected: JournalReducerState): void {
  expect(Object.keys(actual)).toEqual(Object.keys(expected))
  const actualFields: Record<string, unknown> = { ...actual }
  const expectedFields: Record<string, unknown> = { ...expected }
  for (const [field, right] of Object.entries(expectedFields)) {
    const left = actualFields[field]
    if (
      (left instanceof Map && right instanceof Map) ||
      (left instanceof Set && right instanceof Set)
    ) {
      expect([...left]).toStrictEqual([...right])
    } else if (field === 'queue') {
      expect([...actual.queue.cards]).toStrictEqual([...expected.queue.cards])
      expect(actual.queue.revision).toBe(expected.queue.revision)
    } else if (field === 'derivedTurnScope') {
      expect(actual.derivedTurnScope.snapshot()).toBe(expected.derivedTurnScope.snapshot())
    } else {
      expect(left).toStrictEqual(right)
    }
  }
  expect(renderJournalState(actual)).toStrictEqual(renderJournalState(expected))
}

it('round trips the complete replayed reducer, including insertion order and undefined echoes', () => {
  const user = text('Please investigate', 'user')
  const rows: JournalRow[] = [
    { ...base(1), kind: 'epoch', reason: 'legacy_import', providerHandle },
    {
      ...base(2),
      kind: 'queue',
      messageId: 'draft',
      change: {
        op: 'queued',
        body: user,
        position: 1,
        queuedAt: { epoch, sequence: 2 },
        options: { model: 'model-a' }
      }
    },
    {
      ...base(3),
      kind: 'submission',
      clientMessageId: 'send-1',
      payloadFingerprint: agentSessionSendBodyFingerprint(identity.sessionId, user),
      body: user,
      providerHandle,
      handoverRecorded: true,
      queuedMessageId: 'draft',
      origin: 'client'
    },
    {
      ...base(4),
      kind: 'dispatch',
      clientMessageId: 'send-1',
      state: 'pending',
      providerItemId: null,
      reason: null,
      carries: ['stopped-2', 'stopped-1']
    },
    { ...base(5), kind: 'item', itemId: itemId(1), revision: 1, body: user },
    {
      ...base(6),
      kind: 'item',
      itemId: itemId(2),
      revision: 1,
      body: text('echo'),
      echoOf: undefined
    },
    { ...base(7), kind: 'item', itemId: itemId(3), revision: 1, body: text('removed') },
    { ...base(8), kind: 'tombstone', itemId: itemId(3), revision: 2 },
    {
      ...base(9),
      kind: 'tombstone',
      itemId: 'stop',
      revision: 1,
      stopEvent: { reason: 'user-stop', at: 1_009 }
    },
    {
      ...base(10),
      kind: 'tombstone',
      itemId: 'clear',
      revision: 1,
      queueClear: { operationId: 'clear-1', messageIds: ['draft'] }
    },
    { ...base(11), kind: 'tombstone', itemId: 'reopen', revision: 1, queueReopen: true }
  ]
  for (let index = 0; index < MAX_JOURNAL_APPLIED_SETTLEMENT_IDS + 2; index++) {
    rows.push({
      ...base(rows.length + 1),
      kind: 'lifecycle-batch',
      settlementId: `settlement-${index}`,
      mutations: [
        { kind: 'item', itemId: itemId(4), revision: index + 1, body: text(`progress ${index}`) }
      ]
    })
  }
  rows.push({
    ...base(rows.length + 1),
    kind: 'item',
    itemId: itemId(7),
    revision: 1,
    body: { kind: 'turn', turnId: 'removed-turn', state: 'running' }
  })
  rows.push({ ...base(rows.length + 1), kind: 'tombstone', itemId: itemId(7), revision: 2 })
  rows.push({
    ...base(rows.length + 1),
    kind: 'item',
    itemId: itemId(5),
    revision: 1,
    body: { kind: 'turn', turnId: 'open-turn', state: 'running' }
  })
  rows.push({
    ...base(rows.length + 1),
    kind: 'item',
    itemId: itemId(6),
    revision: 1,
    executionOwner: 2,
    body: text('Working')
  })
  const state = write(rows)
  expect(state.items.has(agentJournalSubmissionKey('send-1'))).toBe(true)
  expect(state.itemEchoes.has(itemId(2))).toBe(true)
  expect(state.itemEchoes.get(itemId(2))).toBeUndefined()
  expect([...state.appliedSettlementIds][0]).toBe('settlement-2')
  expect(state.derivedTurnScope.snapshot()).toBe(itemId(5))
  expect(saveJournalState(database, state)).toBe(true)
  const restored = requireState(readJournalSavedState(database.db, identity.sessionId, epoch))
  expectSameState(restored, state)
  expect(restored.derivedTurnScope.scopeFor(text('next'))).toEqual({
    kind: 'turn',
    turnItemId: itemId(5)
  })
  expect(liveTestJournalRows(database.db, identity.sessionId)).toHaveLength(rows.length)
})

it('opens the saved prefix plus a tail like full replay and still refuses a damaged tail', async () => {
  const state = write([
    { ...base(1), kind: 'epoch', reason: 'session_created', providerHandle },
    { ...base(2), kind: 'item', itemId: itemId(1), revision: 1, body: text('First') }
  ])
  expect(saveJournalState(database, state)).toBe(true)
  insertTestJournalRow(database.db, identity.sessionId, {
    ...base(3),
    kind: 'item',
    itemId: itemId(1),
    revision: 2,
    body: text('Complete')
  })
  const full = requireState(replayJournal(database.db, identity.sessionId)?.state)
  expectSameState(requireState(restoreJournal(database.db, identity.sessionId)?.state), full)
  const journal = await journals.open({ identity, stateDirectory: root })
  expect(journal.snapshot()).toStrictEqual(renderJournalState(full))
  for (const direction of ['tail', 'before', 'after'] as const) {
    const request = {
      sessionId: identity.sessionId,
      direction,
      cursor: { epoch, sequence: direction === 'before' ? 4 : 1 },
      limit: 1
    }
    expect(readAgentSessionHistory(journal, request)).toStrictEqual(
      readAgentSessionHistory(journal, request, { snapshot: renderJournalState(full) })
    )
  }
  insertTestJournalRowJson(database.db, identity.sessionId, 4, '{damaged')
  const damaged = restoreJournal(database.db, identity.sessionId)
  expect(damaged?.damage).toEqual({ sequence: 4, cause: 'unparseable-row' })
  if (!damaged) {
    throw new Error('missing load')
  }
  expect(() => failLoadOnUnloadableJournal(identity.sessionId, damaged)).toThrow()
  await journal.close()
  expect(readJournalSavedState(database.db, identity.sessionId, epoch)?.lastSequence).toBe(3)
  await expect(journals.open({ identity, stateDirectory: root })).rejects.toMatchObject({
    refusal: { details: { reason: 'journalCorrupt' } }
  })
})

it('keeps newer checkpoints across stale publishes and failures and clears them on epoch changes', async () => {
  const state = write([
    { ...base(1), kind: 'epoch', reason: 'session_created', providerHandle },
    { ...base(2), kind: 'item', itemId: itemId(1), revision: 1, body: text('First') }
  ])
  saveJournalState(database, state)
  const older = requireState(readJournalSavedState(database.db, identity.sessionId, epoch))
  const tail: JournalRow = {
    ...base(3),
    kind: 'item',
    itemId: itemId(1),
    revision: 2,
    body: text('New')
  }
  insertTestJournalRow(database.db, identity.sessionId, tail)
  applyJournalRow(state, tail)
  expect(saveJournalState(database, state)).toBe(true)
  expect(saveJournalState(database, older)).toBe(false)
  expectSameState(
    requireState(readJournalSavedState(database.db, identity.sessionId, epoch)),
    state
  )
  const before = database.db.prepare('SELECT state_json FROM journal_state').get()?.state_json
  database.db.exec(
    "CREATE TRIGGER fail_checkpoint BEFORE INSERT ON journal_state BEGIN SELECT RAISE(ABORT, 'save failed'); END"
  )
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const last: JournalRow = {
    ...base(4),
    kind: 'item',
    itemId: itemId(1),
    revision: 3,
    body: text('Still sends')
  }
  insertTestJournalRow(database.db, identity.sessionId, last)
  applyJournalRow(state, last)
  expect(saveJournalState(database, state)).toBe(false)
  expect(database.db.prepare('SELECT state_json FROM journal_state').get()?.state_json).toBe(before)
  expect(
    readJournalSavedState(database.db, identity.sessionId, epoch)?.items.get(itemId(1))?.revision
  ).toBe(2)
  database.db.exec('DROP TRIGGER fail_checkpoint')
  let nextEpoch = 1
  const journal = await journals.open({
    identity,
    stateDirectory: root,
    mintEpoch: () => `epoch-${++nextEpoch}`
  })
  await journal.rollEpoch('handle_forked', 2)
  expect(database.db.prepare('SELECT 1 FROM journal_state').get()).toBeUndefined()
  expect(database.db.prepare('SELECT 1 FROM journal_items').get()).toBeUndefined()
  expect(saveJournalState(database, state)).toBe(false)
  await journal.checkpoint()
  await journal.replaceEpochItems('legacy_import', 2, [])
  expect(database.db.prepare('SELECT 1 FROM journal_state').get()).toBeUndefined()
  expect(database.db.prepare('SELECT 1 FROM journal_items').get()).toBeUndefined()
})

it('backfills a closed chat without changing rows and sweeps retired epochs', async () => {
  const rows: JournalRow[] = [
    { ...base(1), kind: 'epoch', reason: 'session_created', providerHandle }
  ]
  for (let index = 0; index < 70; index++) {
    rows.push({
      ...base(rows.length + 1),
      kind: 'item',
      itemId: itemId(1),
      revision: index + 1,
      body: text(`revision ${index}`)
    })
  }
  write(rows)
  const before = liveTestJournalRows(database.db, identity.sessionId)
  let clock = 0
  const rest = vi.fn(async () => {})
  await backfillJournalState({
    database: () => database,
    checkpointOpen: async () => false,
    stopped: () => false,
    now: () => (clock += 30),
    rest
  })
  expect(rest).toHaveBeenCalled()
  expectSameState(
    requireState(readJournalSavedState(database.db, identity.sessionId, epoch)),
    requireState(replayJournal(database.db, identity.sessionId)?.state)
  )
  expect(liveTestJournalRows(database.db, identity.sessionId)).toStrictEqual(before)
  // An older writer can switch epochs without knowing about checkpoints.
  publishTestJournalEpoch(database.db, identity.sessionId, 'older-writer-epoch')
  sweepJournalSavedState(database)
  expect(database.db.prepare('SELECT 1 FROM journal_state').get()).toBeUndefined()
  expect(database.db.prepare('SELECT 1 FROM journal_items').get()).toBeUndefined()
})

it.each(['settling', 'bound', 'failed'] as const)(
  'restores only durable Stop facts from a %s checkpoint, including prior v1 payloads',
  async (mode) => {
    write([{ ...base(1), kind: 'epoch', reason: 'session_created', providerHandle }])
    const now = () => 2_000
    const journal = await journals.open({ identity, stateDirectory: root, now })
    await journal.appendStopEvent({ reason: 'user-stop' }, 1)
    const settle = journal.stopMarks.beginSettle(true)
    expect(settle).not.toBeNull()
    if (mode === 'bound') {
      journal.stopMarks.settled(settle, 'old-turn')
    } else if (mode === 'failed') {
      journal.stopMarks.settled(settle, undefined, { openedAfter: journal.cursor().sequence })
    }
    await journal.checkpoint()
    const saved = database.db.prepare('SELECT state_json FROM journal_state').get()?.state_json
    if (typeof saved !== 'string') {
      throw new Error('missing checkpoint')
    }
    expect(JSON.parse(saved).queuePauseMarks.latestStop).not.toHaveProperty('settle')
    expect(journal.stopMarks.latest()?.settle).toBe(settle)
    // Recreate an earlier v1 payload, which serialized the same live-only binding.
    const previousV1 = JSON.parse(saved)
    previousV1.queuePauseMarks.latestStop.settle = settle
    database.db.prepare('UPDATE journal_state SET state_json = ?').run(JSON.stringify(previousV1))
    journal.stopMarks.settled(settle)
    await journal.close()

    const full = requireState(replayJournal(database.db, identity.sessionId)?.state)
    const replayMarks = new JournalStopMarks({ state: () => full })
    const reopened = await journals.open({ identity, stateDirectory: root, now })
    expectSameState(requireState(restoreJournal(database.db, identity.sessionId)?.state), full)
    expect(reopened.stopMarks.latest()).toStrictEqual(replayMarks.latest())
    expect(structuredAgentSessionStopping(reopened, reopened.snapshot().items)).toBe(false)

    const user = text('Another request', 'user')
    await reopened.appendSubmission({
      clientMessageId: 'new-send',
      payloadFingerprint: agentSessionSendBodyFingerprint(identity.sessionId, user),
      body: user,
      fence: 1,
      handoverRecorded: true
    })
    const turn = {
      provider: 'codex',
      threadId: 'thread-1',
      turnId: 'new-turn',
      ordinal: 0
    } as const
    await reopened.appendItem(
      turn,
      { kind: 'turn', turnId: 'new-turn', state: 'running' },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    expect(structuredAgentSessionStopping(reopened, reopened.snapshot().items)).toBe(false)
    expect(reopened.stopMarks.personStopDecides('new-turn')).toBe(false)
    await reopened.appendItem(
      turn,
      { kind: 'turn', turnId: 'new-turn', state: 'interrupted', completedAt: 2_001 },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    expect(reopened.itemBody(agentJournalItemKey(turn))).not.toHaveProperty('outcome')
    expect(reopened.snapshot()).toStrictEqual(
      renderJournalState(requireState(replayJournal(database.db, identity.sessionId)?.state))
    )
  }
)

it('repairs an unreadable equal checkpoint through open and keeps a newer published prefix', async () => {
  const original = write([
    { ...base(1), kind: 'epoch', reason: 'session_created', providerHandle },
    { ...base(2), kind: 'item', itemId: itemId(1), revision: 1, body: text('First') }
  ])
  saveJournalState(database, original)
  database.db.prepare('UPDATE journal_state SET state_json = ?').run('{')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const journal = await journals.open({ identity, stateDirectory: root })
  await journal.checkpoint()
  await journal.close()
  expectSameState(
    requireState(readJournalSavedState(database.db, identity.sessionId, epoch)),
    original
  )
  const second = await journals.open({ identity, stateDirectory: root })
  expect(second.snapshot()).toStrictEqual(renderJournalState(original))
  const older = requireState(readJournalSavedState(database.db, identity.sessionId, epoch))
  const newer: JournalRow = {
    ...base(3),
    kind: 'item',
    itemId: itemId(1),
    revision: 2,
    body: text('Newer')
  }
  insertTestJournalRow(database.db, identity.sessionId, newer)
  applyJournalRow(original, newer)
  expect(saveJournalState(database, original)).toBe(true)
  await second.checkpoint()
  await second.close()
  expect(saveJournalState(database, older, true)).toBe(false)
  expectSameState(
    requireState(readJournalSavedState(database.db, identity.sessionId, epoch)),
    original
  )
})

it('keeps admitted writes and later sends usable when checkpoint publication fails', async () => {
  write([{ ...base(1), kind: 'epoch', reason: 'session_created', providerHandle }])
  const journal = await journals.open({ identity, stateDirectory: root })
  await journal.checkpoint()
  database.db.exec(
    "CREATE TRIGGER fail_checkpoint BEFORE INSERT ON journal_state BEGIN SELECT RAISE(ABORT, 'save failed'); END"
  )
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const item = { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal: 1 } as const
  await journal.appendItem(item, text('First'), {
    fence: 1,
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  })
  await journal.checkpoint()
  let admitted: Promise<unknown> | undefined
  let closed: Promise<void> | undefined
  await journal.readInOrder(() => {
    admitted = journal.appendItem(item, text('Still sends'), {
      fence: 1,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
    closed = journal.close()
  })
  await admitted
  await closed
  expect(journal.itemBody(agentJournalItemKey(item))).toStrictEqual(text('Still sends'))
  await expect(
    journal.appendItem(item, text('Too late'), {
      fence: 1,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
  ).rejects.toThrow()
  database.db.exec('DROP TRIGGER fail_checkpoint')
  const reopened = await journals.open({ identity, stateDirectory: root })
  expect(reopened.itemBody(agentJournalItemKey(item))).toStrictEqual(text('Still sends'))
})
