import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openCompactionConsumerJournal } from '../agent-session-journal/journal-compaction-consumers.test-support'
import {
  COMPACTION_IDENTITY,
  COMPACTION_RETAINED_SEQUENCES,
  compactionTransportCorpus
} from '../../../shared/journal-compaction-frames.test-fixture'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession
} from '../../../shared/structured-agent-session-reducer'
import { projectJournalBatch } from './agent-session-journal-batch'
import { readQueuePublication } from './structured-agent-session-queued-publication'
import { CLIENT_HISTORY_READER } from './agent-session-item-wire-form'
import { StructuredAgentSessionCurrentWork } from './structured-agent-session-current-work'
import { liveTestJournalRows } from '../agent-session-journal/journal-host-database-test-support'
import Database from '../../sqlite/sync-database'
import {
  AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
  type AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'
import { AGENT_SESSION_HISTORY_MAX_LIMIT } from '../../../shared/agent-session-wire'
import * as rowSchema from '../agent-session-journal/journal-row-schema'
import {
  createTrackedJournalOpener,
  openTestJournalHostDatabase,
  insertTestJournalRow,
  publishTestJournalEpoch,
  deleteTestJournalRow,
  updateTestJournalRowJson
} from '../agent-session-journal/journal-host-database-test-support'
import { AgentSessionSubscribers } from './structured-agent-session-subscribers'
import { readAgentSessionHistory } from './agent-session-history-page'
import {
  agentSessionJournalProviderHandle,
  codexProviderHandle
} from '../../../shared/agent-session-provider-handle-encoding'

const identity: AgentSessionJournalIdentity = {
  sessionId: 'bounded-catch-up',
  workspaceId: 'folder-workspace',
  hostId: 'remote-host',
  agent: 'codex',
  providerHandle: codexProviderHandle('thread-1')
}
const journals = createTrackedJournalOpener()
let root: string | undefined

afterEach(async () => {
  vi.restoreAllMocks()
  await journals.closeAll()
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
})

async function seedJournal(count: number) {
  root = await mkdtemp(join(tmpdir(), 'orca-history-read-budget-'))
  const { db } = openTestJournalHostDatabase(root)
  const base = {
    v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
    epoch: 'epoch-1',
    fence: 1,
    ts: 1_000
  }
  db.exec('BEGIN IMMEDIATE')
  publishTestJournalEpoch(db, identity.sessionId, base.epoch)
  insertTestJournalRow(db, identity.sessionId, {
    ...base,
    kind: 'epoch',
    seq: 1,
    reason: 'session_created',
    providerHandle: agentSessionJournalProviderHandle(identity)
  })
  for (let index = 0; index < count; index += 1) {
    insertTestJournalRow(db, identity.sessionId, {
      ...base,
      kind: 'item',
      seq: index + 2,
      itemId: `item-${index}`,
      revision: 1,
      body: {
        kind: 'message',
        role: 'assistant',
        blocks: [{ type: 'text', text: `${index}:${'x'.repeat(4096)}` }]
      }
    })
  }
  db.exec('COMMIT')
  return journals.open({ identity, stateDirectory: root })
}

function observeForwardReads() {
  const returnedRows: number[] = []
  const observed = new WeakSet<object>()
  const prepare = Database.prototype.prepare
  vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (this: Database, sql) {
    const statement = prepare.call(this, sql)
    if (sql.includes('seq > ?') && !observed.has(statement)) {
      observed.add(statement)
      const all = statement.all.bind(statement)
      vi.spyOn(statement, 'all').mockImplementation((...args) => {
        const rows = all(...args)
        returnedRows.push(rows.length)
        return rows
      })
    }
    return statement
  })
  const parse = vi.spyOn(rowSchema, 'parseJournalRow')
  return { returnedRows, parse }
}

describe('forward history SQL read budget', () => {
  it.each([200, 2_000, 20_000])('bounds reconnect reads after %i missed rows', async (count) => {
    const journal = await seedJournal(count)
    const { returnedRows, parse } = observeForwardReads()
    const events: AgentSessionSubscribeEvent[] = []
    new AgentSessionSubscribers().open({
      id: 'reader',
      sessionId: identity.sessionId,
      journal,
      fence: 1,
      cursor: { epoch: journal.epoch, sequence: 1 },
      emit: (event) => events.push(event)
    })
    expect(events).toHaveLength(1)
    const event = events[0]!
    expect(event.type).toBe(count > 200 ? 'snapshot' : 'batch')
    const items =
      event.type === 'snapshot' ? event.page.items : event.type === 'batch' ? event.batch.items : []
    expect(items.map((item) => item.itemId)).toEqual(
      Array.from({ length: 200 }, (_, index) => `item-${count - 200 + index}`)
    )
    expect(returnedRows).toEqual([Math.min(count, 201)])
    expect(parse).toHaveBeenCalledTimes(Math.min(count, 201))
  })

  it('keeps an exact final page final and preserves unlimited journal readers', async () => {
    const journal = await seedJournal(6)
    const cursor = { epoch: journal.epoch, sequence: 1 }
    expect(journal.readSince(cursor)).toMatchObject({ ok: true, rows: expect.any(Array) })
    const first = readAgentSessionHistory(journal, {
      sessionId: identity.sessionId,
      direction: 'after',
      cursor,
      limit: 3
    })
    expect(first).toMatchObject({ ok: true, page: { hasNewer: true } })
    if (!first.ok) {
      throw new Error('Expected first page')
    }
    const last = readAgentSessionHistory(journal, {
      sessionId: identity.sessionId,
      direction: 'after',
      cursor: first.page.window.nextCursor,
      limit: 3
    })
    expect(last).toMatchObject({ ok: true, page: { hasNewer: false } })
    const unlimited = journal.readSince(cursor)
    expect(unlimited.ok && unlimited.rows).toHaveLength(6)
  })

  it('advances forward pages across retired row sequences', async () => {
    const journal = await seedJournal(6)
    const { db } = openTestJournalHostDatabase(root!)
    deleteTestJournalRow(db, identity.sessionId, 4)
    const first = readAgentSessionHistory(journal, {
      sessionId: identity.sessionId,
      direction: 'after',
      cursor: { epoch: journal.epoch, sequence: 1 },
      limit: 2
    })
    expect(first).toMatchObject({ ok: true, page: { hasNewer: true } })
    if (!first.ok) {
      throw new Error('Expected first page')
    }
    expect(
      readAgentSessionHistory(journal, {
        sessionId: identity.sessionId,
        direction: 'after',
        cursor: first.page.window.nextCursor,
        limit: 2
      })
    ).toMatchObject({ ok: true, page: { hasNewer: true, window: { nextCursor: { sequence: 6 } } } })
  })

  it.each(['{', '{"v":9999}'])(
    'preserves parse-stop behavior at lookahead: %s',
    async (rowJson) => {
      const journal = await seedJournal(6)
      const { db } = openTestJournalHostDatabase(root!)
      updateTestJournalRowJson(db, identity.sessionId, 4, rowJson)
      const page = readAgentSessionHistory(journal, {
        sessionId: identity.sessionId,
        direction: 'after',
        cursor: { epoch: journal.epoch, sequence: 1 },
        limit: 2
      })
      expect(page).toMatchObject({
        ok: true,
        page: { hasNewer: false, window: { nextCursor: { sequence: 3 } } }
      })
      if (!page.ok) {
        throw new Error('Expected valid prefix')
      }
      expect(page.page.items.map((item) => item.itemId)).toEqual(['item-0', 'item-1'])
    }
  )
})

it.each([
  { snapshotCatchUp: false, readsCurrentRequests: false, boundedFrames: false },
  { snapshotCatchUp: true, readsCurrentRequests: true, boundedFrames: true }
])(
  'delivers an actually retired/reopened journal through old/new client capabilities: %j',
  async (capabilities) => {
    root = await mkdtemp(join(tmpdir(), 'orca-compaction-consumers-'))
    const scenario = await openCompactionConsumerJournal(journals, root)
    const canonical = (id: string) => scenario.journal.canonicalItemId(id)
    const projection = (sequence: number) => {
      const read = scenario.journal.readSince({ epoch: scenario.journal.epoch, sequence })
      if (!read.ok) throw new Error('unexpected cursor reset')
      return projectJournalBatch({
        rows: read.rows,
        snapshot: scenario.journal.snapshot(),
        afterSequence: sequence,
        canonicalItemId: canonical
      })
    }
    const expected = Array.from({ length: 16 }, (_, sequence) => projection(sequence))
    const original = scenario.journal.snapshot()
    const runSubscriber = (sequence: number) => {
      const events: AgentSessionSubscribeEvent[] = []
      const subscribers = new AgentSessionSubscribers({
        now: () => 0,
        readCurrentWork: (_session, journal) =>
          new StructuredAgentSessionCurrentWork(journal, 1, 0),
        readQueuePublication: () =>
          readQueuePublication(scenario.journal, (journal) => ({
            record: null,
            work: new StructuredAgentSessionCurrentWork(journal, 1, 0)
          }))
      })
      subscribers.open({
        ...capabilities,
        id: 'reader',
        sessionId: COMPACTION_IDENTITY.sessionId,
        journal: scenario.journal,
        fence: 1,
        cursor: { epoch: scenario.journal.epoch, sequence },
        emit: (event) => events.push(structuredClone(event))
      })
      let state = reduceStructuredAgentSession(
        EMPTY_STRUCTURED_AGENT_SESSION,
        {
          type: 'event',
          event: compactionTransportCorpus(Math.max(1, sequence)).snapshot
        },
        0
      )
      if (sequence === 0)
        state = {
          ...EMPTY_STRUCTURED_AGENT_SESSION,
          epoch: scenario.journal.epoch,
          cursor: { epoch: scenario.journal.epoch, sequence: 0 }
        }
      for (const event of events)
        state = reduceStructuredAgentSession(state, { type: 'event', event }, 0)
      return { events, state }
    }
    const baseline = Array.from({ length: 16 }, (_, sequence) => runSubscriber(sequence).state)
    const tailBefore = readAgentSessionHistory(scenario.journal, {
      sessionId: COMPACTION_IDENTITY.sessionId,
      direction: 'tail',
      limit: 2
    })
    const olderBefore = readAgentSessionHistory(scenario.journal, {
      sessionId: COMPACTION_IDENTITY.sessionId,
      direction: 'before',
      cursor: { epoch: scenario.journal.epoch, sequence: 9 },
      limit: 2
    })
    await scenario.retireAndReopen()
    expect(
      liveTestJournalRows(openTestJournalHostDatabase(root).db, COMPACTION_IDENTITY.sessionId).map(
        (row) => row.seq
      )
    ).toEqual(COMPACTION_RETAINED_SEQUENCES)
    expect(scenario.journal.snapshot()).toEqual(original)
    for (let sequence = 0; sequence <= 15; sequence++) {
      expect(projection(sequence)).toEqual(expected[sequence])
      const delivered = runSubscriber(sequence)
      expect(delivered.state).toEqual(baseline[sequence])
      expect(delivered.state.cursor).toEqual(original.cursor)
      expect(delivered.state.items).toEqual(original.items)
      expect(delivered.state.items.some((item) => item.itemId === 'removed')).toBe(false)
      expect(delivered.state.actionablePromptIds).toEqual(['prompt'])
      expect(delivered.state.working).toBe(true)
      expect(delivered.state.queuedMessages?.map((card) => card.messageId)).toEqual(['draft'])
      let cursor = { epoch: scenario.journal.epoch, sequence }
      for (let pageCount = 0; pageCount < 16; pageCount++) {
        const result = readAgentSessionHistory(scenario.journal, {
          sessionId: COMPACTION_IDENTITY.sessionId,
          direction: 'after',
          cursor,
          limit: 2
        })
        if (!result.ok) throw new Error('unexpected sparse history reset')
        if (!result.page.hasNewer) {
          expect(result.page.window.nextCursor).toEqual(original.cursor)
          break
        }
        expect(result.page.window.nextCursor.sequence).toBeGreaterThan(cursor.sequence)
        cursor = result.page.window.nextCursor
        expect(pageCount).toBeLessThan(15)
      }
    }
    expect(
      readAgentSessionHistory(scenario.journal, {
        sessionId: COMPACTION_IDENTITY.sessionId,
        direction: 'tail',
        limit: 2
      })
    ).toEqual(tailBefore)
    expect(
      readAgentSessionHistory(scenario.journal, {
        sessionId: COMPACTION_IDENTITY.sessionId,
        direction: 'before',
        cursor: { epoch: scenario.journal.epoch, sequence: 9 },
        limit: 2
      })
    ).toEqual(olderBefore)
    let client: ReturnType<typeof reduceStructuredAgentSession> = {
      ...EMPTY_STRUCTURED_AGENT_SESSION,
      epoch: scenario.journal.epoch,
      cursor: { epoch: scenario.journal.epoch, sequence: 1 }
    }
    for (let step = 0; step < 16; step++) {
      const result = readAgentSessionHistory(
        scenario.journal,
        {
          sessionId: COMPACTION_IDENTITY.sessionId,
          direction: 'after',
          cursor: client.cursor!,
          limit: 12
        },
        { reader: { ...CLIENT_HISTORY_READER, budgetBytes: 1024 } }
      )
      if (!result.ok) throw new Error('unexpected bounded sparse reset')
      if (step === 0) expect(result.page.window.nextCursor.sequence).toBeLessThan(15)
      client = reduceStructuredAgentSession(
        client,
        {
          type: 'event',
          event: {
            type: 'batch',
            sessionId: COMPACTION_IDENTITY.sessionId,
            batch: {
              cursor: result.page.window.nextCursor,
              items: result.page.items,
              submissions: result.page.submissions,
              removedItemIds: result.page.removedItemIds
            }
          }
        },
        0
      )
      if (!result.page.hasNewer) break
      expect(step).toBeLessThan(15)
    }
    expect(client.cursor).toEqual(original.cursor)
    expect(client.items).toEqual(original.items)
    // The exact shared immutable corpus is checked against SQLite and production producer callbacks.
    const corpus = compactionTransportCorpus()
    const events: AgentSessionSubscribeEvent[] = []
    const producer = new AgentSessionSubscribers({ now: () => 0 })
    producer.open({
      id: 'snapshot',
      sessionId: COMPACTION_IDENTITY.sessionId,
      journal: scenario.journal,
      fence: 1,
      emit: (event) => events.push(event)
    })
    expect(events[0]).toMatchObject(corpus.snapshot)
    producer.open({
      id: 'resume',
      sessionId: COMPACTION_IDENTITY.sessionId,
      journal: scenario.journal,
      fence: 1,
      cursor: { epoch: scenario.journal.epoch, sequence: 7 },
      snapshotCatchUp: false,
      emit: (event) => events.push(event)
    })
    expect(events.at(-1)).toMatchObject(corpus.frame)
    expect(olderBefore).toEqual({ ok: true, page: corpus.older })
    expect(tailBefore).toEqual({ ok: true, page: corpus.tail })
    if (capabilities.snapshotCatchUp) {
      // Retained non-item rows force a second catch-up page without expanding the visible window.
      for (let index = 0; index <= AGENT_SESSION_HISTORY_MAX_LIMIT; index++)
        await scenario.journal.appendQueueResume(1)
      expect(scenario.journal.publicRead().normalizationKey).toBe('')
      expect(
        readAgentSessionHistory(scenario.journal, {
          sessionId: COMPACTION_IDENTITY.sessionId,
          direction: 'after',
          cursor: { epoch: scenario.journal.epoch, sequence: 7 },
          limit: AGENT_SESSION_HISTORY_MAX_LIMIT
        })
      ).toMatchObject({ ok: true, page: { hasNewer: true } })
      const fallback = runSubscriber(7)
      expect(fallback.events[0]?.type).toBe('snapshot')
      expect(fallback.events.some((event) => event.type === 'reset')).toBe(false)
      const current = scenario.journal.snapshot()
      expect(fallback.state.items).toEqual(current.items)
      expect(fallback.state.submissions).toEqual(current.submissions)
      expect(fallback.state.cursor).toEqual(current.cursor)
      expect(fallback.state.items.some((item) => item.itemId === 'removed')).toBe(false)
      expect(fallback.state.actionablePromptIds).toEqual(['prompt'])
      expect(fallback.state.working).toBe(true)
      expect(fallback.state.queuedMessages?.map((card) => card.messageId)).toEqual(['draft'])
    }
  }
)
