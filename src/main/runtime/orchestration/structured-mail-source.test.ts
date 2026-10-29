import { OrchestrationDb } from './db'
import { describe, expect, it, vi } from 'vitest'
import { readAgentMessageSource } from '../../../shared/agent-session/agent-session-message-source'
import { agentMessageHeading } from '../../../shared/agent-session/agent-message-presentation'
import { agentSessionConversationView } from '../../../shared/agent-session-conversation-view'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../shared/agent-session-record.test-fixture'
import { testOrcaSessionId } from '../../../shared/orca-session-address-test-fixture'
import type { SenderNameResolver } from './agent-message-sender'
import { orchestrationSenderName } from './orchestration-sender-name'
import * as canonical from './canonical-orca-session-id'
import * as parties from './orchestration-party'
import * as relations from './agent-message-relation'
import { structuredWorkerIdentities } from '../structured-worker-identity'
import * as lineage from './structured-session-lineage'
import { structuredMailSource, type MailSourceMessage } from './structured-mail-source'

const SESSION = '4a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37'

describe('who delivered mail is from', () => {
  it("names each sender once, without the pane key that would open its mailbox, and each message's own sender", () => {
    // No database: a terminal handle and a session address name their party by themselves.
    const source = structuredMailSource({
      db: null,
      mailboxHandle: 'run:r1',
      dispatchId: null,
      batch: [
        { id: 'm1', from_handle: 'term_a', run_id: 'r1', type: 'status', payload: null },
        {
          id: 'm2',
          from_handle: `orca_session_id:${SESSION}`,
          run_id: 'r2',
          type: 'status',
          payload: null
        },
        { id: 'm3', from_handle: 'term_a', run_id: 'r1', type: 'status', payload: null }
      ],
      senderName: (party) => (party.terminalHandle === 'term_a' ? 'Build tab' : null)
    })
    expect(source).toEqual({
      kind: 'agent',
      senders: [
        {
          party: { address: 'term_a', terminalHandle: 'term_a', orcaSessionId: null },
          name: 'Build tab'
        },
        {
          party: {
            address: `orca_session_id:${SESSION}`,
            terminalHandle: null,
            orcaSessionId: SESSION
          },
          name: null
        }
      ],
      orchestration: {
        message: 'mail-notice',
        mailbox: 'run:r1',
        dispatchId: null,
        messages: [
          { messageId: 'm1', runId: 'r1', from: 'term_a' },
          { messageId: 'm2', runId: 'r2', from: `orca_session_id:${SESSION}` },
          { messageId: 'm3', runId: 'r1', from: 'term_a' }
        ]
      }
    })
  })

  it('bounds a snapshot name, and a naming failure costs only the name', () => {
    const named = (senderName: (party: unknown) => string | null) =>
      structuredMailSource({
        db: null,
        mailboxHandle: 'run:r1',
        dispatchId: null,
        batch: [{ id: 'm1', from_handle: 'term_a', run_id: 'r1', type: 'status', payload: null }],
        senderName
      }).senders[0]?.name
    expect(named(() => `  Build\n${'x'.repeat(400)}`)).toHaveLength(200)
    expect(named(() => '   ')).toBeNull()
    expect(
      named(() => {
        throw new Error('records unavailable')
      })
    ).toBeNull()
  })
})

it('preserves immediate historical relations, notice evidence disagreement, reload and clear successors', () => {
  const db = new OrchestrationDb(':memory:')
  try {
    const run = db.createRun({
      objective: 'cards',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab:coord'
    })
    const assign = (handle: string, creator: string) =>
      db.createDispatchContext({
        taskId: db.createTask({ runId: run.id, spec: handle }).id,
        assigneeHandle: handle,
        assigneePaneKey: `tab:${handle}`,
        creator: { kind: 'terminal', handle: creator },
        maxDepth: 8
      })
    const worker = assign('term_worker', 'term_coord')
    const peer = assign('term_peer', 'term_coord')
    const child = assign('term_child', 'term_worker')
    const mail = (
      recipient: string,
      addresses: string[],
      dispatchId: string | null = null,
      report?: string
    ) =>
      structuredMailSource({
        db,
        mailboxHandle: recipient,
        dispatchId,
        senderName: () => 'Sender',
        batch: addresses.map<MailSourceMessage>((address, i) => ({
          id: `m${i}`,
          from_handle: address,
          run_id: run.id,
          type: report ? 'worker_done' : 'status',
          payload: report ? JSON.stringify({ dispatchId: report }) : null
        }))
      })
    expect(mail('term_coord', ['term_worker']).senders[0].relation).toBe('worker')
    expect(mail('term_worker', ['term_coord'], worker.id).senders[0].relation).toBe('coordinator')
    expect(mail('term_worker', ['term_peer'], worker.id).senders[0].relation).toBe('none')
    expect(mail('term_coord', ['term_child']).senders[0].relation).toBe('none')
    expect(mail('term_coord', ['unknown']).senders[0].relation).toBeUndefined()
    const ambiguous = assign('term_ambiguous', 'term_coord')
    db.db
      .prepare('UPDATE dispatch_contexts SET assignee_handle = ? WHERE id = ?')
      .run('term_worker', ambiguous.id)
    expect(mail('term_coord', ['term_worker']).senders[0].relation).toBeUndefined()
    db.db
      .prepare("UPDATE dispatch_contexts SET status = 'completed' WHERE id = ?")
      .run(ambiguous.id)
    expect(mail('term_coord', ['dispatch:foreign']).senders[0].relation).toBeUndefined()
    db.db.prepare("UPDATE dispatch_contexts SET status = 'completed' WHERE id = ?").run(child.id)
    expect(mail('term_worker', ['term_child'], worker.id, child.id).senders[0].relation).toBe(
      'worker'
    )
    expect(mail('term_coord', ['term_peer'], null, child.id).senders[0].relation).toBeUndefined()
    const reload = (source: ReturnType<typeof mail>) =>
      readAgentMessageSource(JSON.parse(JSON.stringify(source)))!
    expect(agentMessageHeading(reload(mail('term_coord', ['term_worker'])))).toBe('worker')
    expect(agentMessageHeading(reload(mail('term_worker', ['term_coord'], worker.id)))).toBe(
      'coordinator'
    )
    const mixed = reload(mail('term_worker', ['term_child', 'term_peer'], worker.id))
    expect(mixed.senders.map((sender) => sender.relation)).toEqual(['worker', 'none'])
    expect(agentMessageHeading(mixed)).toBe('generic')
    const senderName = vi.fn<SenderNameResolver>(() => 'Worker')
    const evaluate = vi.spyOn(relations, 'agentMessageRelation')
    const base = {
      from_handle: 'term_worker',
      run_id: run.id,
      type: 'worker_done',
      payload: JSON.stringify({ dispatchId: worker.id })
    } satisfies Omit<MailSourceMessage, 'id'>
    const grouped = (batch: MailSourceMessage[]) =>
      structuredMailSource({ db, mailboxHandle: 'term_coord', dispatchId: null, batch, senderName })
    const good = { ...base, id: 'good' }
    for (const other of [
      { ...good, id: 'other-run', run_id: 'missing' },
      { ...good, id: 'bad', payload: '{' },
      { ...good, id: 'empty', payload: '{"dispatchId":""}' },
      { ...good, id: 'missing-id', payload: '{}' },
      { ...good, id: 'wrong', payload: '{"dispatchId":"missing"}' }
    ]) {
      evaluate.mockClear()
      senderName.mockClear()
      const result = grouped([other, good, good])
      expect(result.senders[0].relation).toBeUndefined()
      expect(
        result.orchestration?.message === 'mail-notice' && result.orchestration.messages
      ).toHaveLength(3)
      expect(senderName).toHaveBeenCalledTimes(1)
      expect(senderName.mock.calls[0][1]).toBe(other.id === 'wrong' ? 'missing' : worker.id)
      expect(evaluate).toHaveBeenCalledTimes(
        ['bad', 'empty', 'missing-id'].includes(other.id) ? 1 : 2
      )
    }
    evaluate.mockClear()
    const missing = { ...good, run_id: 'missing' }
    expect(grouped([missing, missing]).senders[0].relation).toBeUndefined()
    expect(evaluate).toHaveBeenCalledTimes(1) // Map membership caches undefined too.
    expect(grouped([{ ...good, type: 'status', payload: null }, good]).senders[0].relation).toBe(
      'worker'
    )
    expect(mail('term_missing', ['term_worker']).senders[0].relation).toBeUndefined()
    for (const depth of [1, 2]) {
      db.db
        .prepare(
          'UPDATE dispatch_contexts SET creator_handle = NULL, creator_orca_session_id = NULL, creator_dispatch_id = NULL, depth = ? WHERE id = ?'
        )
        .run(depth, worker.id)
      expect(reload(mail('term_coord', ['term_worker'])).senders[0].relation).toBeUndefined()
    }
    db.db
      .prepare('UPDATE dispatch_contexts SET creator_dispatch_id = ? WHERE id = ?')
      .run(peer.id, worker.id)
    expect(mail('term_peer', ['term_worker'], peer.id).senders[0].relation).toBe('worker')
    db.db
      .prepare(
        'UPDATE dispatch_contexts SET creator_handle = NULL, creator_dispatch_id = NULL WHERE id = ?'
      )
      .run(worker.id)
    expect(mail('term_coord', ['term_worker']).senders[0].relation).toBeUndefined()
    db.db
      .prepare('UPDATE dispatch_contexts SET creator_handle = ? WHERE id = ?')
      .run('term_coord', worker.id)
    expect(mail('term_coord', ['term_worker']).senders[0].relation).toBe('worker')
    db.db
      .prepare('UPDATE dispatch_contexts SET host_scope = ? WHERE id = ?')
      .run(JSON.stringify({ kind: 'ssh', targetId: 'elsewhere' }), worker.id)
    expect(mail('term_coord', ['term_worker']).senders[0].relation).toBeUndefined()
    const root = testOrcaSessionId('notice-clear-root'),
      successor = testOrcaSessionId('notice-clear-successor')
    const record = agentSessionConversationView(
      agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId: root }))
    )
    const records = [
      {
        ...record,
        conversationCommand: {
          command: 'clear' as const,
          state: 'completed' as const,
          phase: 'committed' as const,
          operationId: 'clear',
          callerKey: 'caller',
          replacementSessionId: successor
        }
      },
      { ...record, sessionId: successor, conversationName: 'Current worker' }
    ]
    const reader = {
      listRecords: () => records,
      getRecord: (id: string) => records.find((row) => row.sessionId === id) ?? null
    }
    vi.spyOn(lineage, 'readAgentSessionRecordStore').mockReturnValue(reader)
    const clearRun = db.createRun({
      objective: 'clear',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: null
    })
    const clearedWorker = db.createDispatchContext({
      taskId: db.createTask({ runId: clearRun.id, spec: 'clear' }).id,
      assigneeHandle: `orca_session_id:${root}`,
      creator: { kind: 'terminal', handle: 'term_coord' },
      maxDepth: 8
    })
    const cleared = structuredMailSource({
      db,
      mailboxHandle: 'term_coord',
      dispatchId: null,
      batch: [
        {
          id: 'clear',
          from_handle: `orca_session_id:${successor}`,
          run_id: clearRun.id,
          type: 'worker_done',
          payload: JSON.stringify({ dispatchId: clearedWorker.id })
        }
      ],
      senderName: (sender, report) =>
        orchestrationSenderName(
          sender,
          {
            db,
            records: reader,
            chatTab: () => null,
            terminal: () => null,
            generatedTitlesEnabled: true
          },
          report
        )
    })
    expect(cleared.senders[0]).toMatchObject({
      party: { orcaSessionId: root },
      relation: 'worker',
      name: 'Current worker'
    })
  } finally {
    vi.restoreAllMocks()
    db.close()
  }
})

it.each([
  [5, 1000, false],
  [50, 10000, false],
  [5, 1000, true],
  [50, 10000, true]
] as const)(
  'counts complete notice acquisition at B=%i S=%i distinct=%s',
  (batchSize, sessionCount, distinct) => {
    const db = new OrchestrationDb(':memory:')
    const coordinator = testOrcaSessionId('relation-coordinator')
    const sessions = Array.from({ length: batchSize }, (_, i) =>
      testOrcaSessionId(`relation-worker-${i}`)
    )
    const base = agentSessionConversationView(
      agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId: sessions[0] }))
    )
    const records: (typeof base)[] = Array.from({ length: sessionCount }, (_, i) => ({
      ...base,
      sessionId:
        i === batchSize ? coordinator : (sessions[i] ?? testOrcaSessionId(`relation-${i}`)),
      conversationName: `Conversation ${i}`
    }))
    const bySession = new Map(records.map((record) => [record.sessionId, record]))
    let scanVisits = 0
    const scanned = new Proxy(records, {
      get(target, key) {
        if (typeof key === 'string' && /^\d+$/.test(key)) {
          scanVisits++
        }
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: plain fixture data has no accessor overrides; methods retain the caller's proxy receiver and indexed reads remain counted.
        return target[key as keyof typeof target]
      }
    })
    const listRecords = vi.fn(() => scanned)
    const getRecord = vi.fn((id: string) => bySession.get(id) ?? null)
    const reader = { listRecords, getRecord }
    vi.spyOn(lineage, 'readAgentSessionRecordStore').mockReturnValue(reader)
    const canonicalCalls = vi.spyOn(canonical, 'canonicalOrcaSessionId')
    const partyCalls = vi.spyOn(parties, 'resolveOrchestrationParty')
    const relationCalls = vi.spyOn(relations, 'agentMessageRelation')
    const registry = vi.spyOn(structuredWorkerIdentities, 'getBySessionId')
    const handleRegistry = vi.spyOn(structuredWorkerIdentities, 'get')
    try {
      const run = db.createRun({
        objective: 'cost',
        coordinatorHandle: null,
        coordinatorPaneKey: null,
        coordinatorOrcaSessionId: coordinator
      })
      const dispatches = sessions.map((session) =>
        db.createDispatchContext({
          taskId: db.createTask({ runId: run.id, spec: 'work' }).id,
          assigneeHandle: `orca_session_id:${session}`,
          creator: { kind: 'session', orcaSessionId: coordinator },
          maxDepth: 8
        })
      )
      const getRun = vi.spyOn(db, 'getRun')
      const byId = db.getDispatchContextById.bind(db)
      let reportedCandidateRows = 0
      const dispatchById = vi.spyOn(db, 'getDispatchContextById').mockImplementation((...args) => {
        const row = byId(...args)
        reportedCandidateRows += row ? 1 : 0
        return row
      })
      const workerRows = vi.spyOn(db, 'getWorkerTerminalResourceByProcessIncarnation')
      const workerHandles = vi.spyOn(db, 'getWorkerTerminalResourceByHandle')
      const nameDispatch = vi.spyOn(db, 'getActiveDispatchForTerminal'),
        tasks = vi.spyOn(db, 'getTask')
      const candidates = db.getActiveDispatchMailboxOwners.bind(db)
      let candidateRows = 0
      const candidateCalls = vi
        .spyOn(db, 'getActiveDispatchMailboxOwners')
        .mockImplementation((...args) => {
          const result = candidates(...args)
          candidateRows += result.length
          return result
        })
      const statements = vi.spyOn(db.db, 'prepare')
      const nameTab = vi.fn(() => null),
        terminal = vi.fn(() => null)
      const senderName = vi.fn<SenderNameResolver>((sender, report) =>
        orchestrationSenderName(
          sender,
          {
            db,
            records: reader,
            chatTab: nameTab,
            terminal,
            generatedTitlesEnabled: true
          },
          report
        )
      )
      let batchVisits = 0,
        payloadParses = 0,
        payloadBytes = 0
      const batch = new Proxy(
        Array.from({ length: batchSize }, (_, i) => ({
          id: `m${i}`,
          from_handle: `orca_session_id:${sessions[distinct ? i : 0]}`,
          run_id: run.id,
          type: 'worker_done' as const,
          payload: JSON.stringify({ dispatchId: dispatches[distinct ? i : 0].id })
        })),
        {
          get(target, key) {
            if (typeof key === 'string' && /^\d+$/.test(key)) {
              batchVisits++
            }
            // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: plain fixture data has no accessor overrides; methods retain the caller's proxy receiver and indexed reads remain counted.
            return target[key as keyof typeof target]
          }
        }
      )
      const payloads = new Set(batch.map((message) => message.payload))
      const parse = JSON.parse
      vi.spyOn(JSON, 'parse').mockImplementation((value, ...rest) => {
        if (payloads.has(value)) {
          payloadParses++
          payloadBytes += value.length
        }
        return parse(value, ...rest)
      })
      const groups = distinct ? batchSize : 1
      batchVisits = 0
      const source = structuredMailSource({
        db,
        mailboxHandle: `orca_session_id:${coordinator}`,
        dispatchId: null,
        batch,
        senderName
      })
      expect(agentMessageHeading(readAgentMessageSource(parse(JSON.stringify(source)))!)).toBe(
        'worker'
      )
      expect(
        source.orchestration?.message === 'mail-notice' && source.orchestration.messages
      ).toHaveLength(batchSize)
      expect(source.senders).toHaveLength(groups)
      expect(senderName).toHaveBeenCalledTimes(groups)
      expect(nameTab).toHaveBeenCalledTimes(groups)
      expect(getRecord).toHaveBeenCalledTimes(groups) // Actual name lineage, separate from full canonical scans.
      expect(terminal).not.toHaveBeenCalled()
      expect(relationCalls).toHaveBeenCalledTimes(groups)
      expect(getRun).toHaveBeenCalledTimes(groups)
      expect(dispatchById).toHaveBeenCalledTimes(groups)
      expect(reportedCandidateRows).toBe(groups) // Every explicit report returns one real candidate.
      expect(candidateCalls).toHaveBeenCalledTimes(groups)
      expect(candidateRows).toBe(0) // Coordinator has no worker Dispatch in this corpus.
      expect(batchVisits).toBe(batchSize * 2) // Grouping and provenance serialization, no per-sender filter.
      expect(payloadParses).toBe(batchSize)
      expect(payloadBytes).toBe(batch.reduce((sum, message) => sum + message.payload.length, 0))
      expect(partyCalls).toHaveBeenCalledTimes(groups * 2) // Sender plus actual recipient, neither mocked away.
      expect(canonicalCalls).toHaveBeenCalledTimes(groups * 8)
      expect(listRecords).toHaveBeenCalledTimes(groups * 8)
      expect(scanVisits).toBe(groups * 8 * sessionCount)
      expect(registry).toHaveBeenCalledTimes(groups * 2)
      expect(workerRows).toHaveBeenCalledTimes(groups * 2)
      expect(handleRegistry).not.toHaveBeenCalled()
      expect(workerHandles).not.toHaveBeenCalled()
      expect(nameDispatch).not.toHaveBeenCalled()
      expect(tasks).not.toHaveBeenCalled()
      // Every SQL query in this corpus is one of these actual acquisition/candidate paths.
      expect(statements.mock.calls.length).toBe(
        getRun.mock.calls.length +
          dispatchById.mock.calls.length +
          candidateCalls.mock.calls.length +
          workerRows.mock.calls.length +
          registry.mock.calls.length
      )
    } finally {
      vi.restoreAllMocks()
      db.close()
    }
  }
)
