import { join } from 'node:path'
import { createTestParams } from './structured-agent-session-create-test-fixture'
import { MailDebts } from '../../runtime/orchestration/structured-mail-source-discovery'
import { hostTestMessage } from './structured-agent-session-host-test-data'
import { afterEach, expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { mailTestResources } from '../../runtime/orchestration/mail-handoff.test-fixture'
import { observeMailSqlWork } from '../../runtime/orchestration/mail-sql-work.test-support'
import { readMailCreationAuthority } from '../agent-session-journal/mail-creation-authority'
import { ordinaryMailCreationId } from '../../runtime/orchestration/structured-mailbox-pointer-delivery'
import { sendAgentTurn } from '../../runtime/orchestration/send-agent-turn'
import { structuredMailSource } from '../../runtime/orchestration/structured-mail-source'
import { setStructuredAgentSessionHost } from './structured-agent-session-registry'
import { eventually } from './structured-agent-session-queued-message-rig.test-fixture'
import {
  hostTestOperationId,
  HOST_TEST_SESSION as SESSION
} from './structured-agent-session-host-test-data'
import {
  rig,
  db,
  bridge,
  clock,
  journal,
  card,
  complete,
  installMailQueueLifecycle,
  openMailQueueSource
} from './structured-agent-session-mail-queue.test-fixture'
installMailQueueLifecycle()
afterEach(() => vi.restoreAllMocks())
it.each([100, 1000])(
  'reconciles a saved random batch through original receipt/member history N=%i after Delete and restart, without recreating either report',
  async (count) => {
    await rig.workingSend()
    bridge.resetForDatabaseChange()
    const [a, b] = db.insertMessages([
      { id: hostTestOperationId(), from: 'worker', to: 'consumer', subject: 'old batch first' },
      { id: hostTestOperationId(), from: 'worker', to: 'consumer', subject: 'old batch second' }
    ])
    if (!a || !b) {
      throw new Error('legacy sources missing')
    }
    const oldId = hostTestOperationId()
    const source = structuredMailSource({
      db,
      mailboxHandle: 'consumer',
      dispatchId: null,
      message: a,
      senderName: () => null
    })
    if (source.orchestration?.message !== 'mail-notice') {
      throw new Error('saved batch source missing')
    }
    const body = {
      kind: 'message' as const,
      role: 'user' as const,
      blocks: [{ type: 'text' as const, text: 'saved ordinary batch content' }],
      from: {
        ...source,
        orchestration: {
          ...source.orchestration,
          messages: [
            ...source.orchestration.messages,
            { messageId: b.id, runId: b.run_id, from: b.from_handle }
          ]
        }
      }
    }
    expect(
      await sendAgentTurn({
        kind: 'structured-session',
        host: rig.host,
        sessionId: SESSION,
        callerKey: 'trusted-local:orchestration:session:old',
        turn: {
          body,
          operationId: oldId,
          expectedRuntimeFence: 1,
          delivery: 'queue',
          queueAlways: true
        }
      })
    ).toMatchObject({ kind: 'queued' })
    expect(await rig.deleteQueued(oldId)).toMatchObject({ ok: true })
    db.db.exec('ALTER TABLE messages ADD COLUMN handoff TEXT')
    const hint = JSON.stringify({
      version: 1,
      kind: 'structured',
      operationId: oldId,
      manifest: { members: [a.id, b.id] }
    })
    for (const row of [a, b]) {
      db.db
        .prepare('UPDATE messages SET ordering_origin = NULL, handoff = ? WHERE id = ?')
        .run(hint, row.id)
    }
    db.resetTasks()
    // The historical helper hand-back cleared this hint independently of ordering provenance.
    db.db.prepare('UPDATE messages SET handoff = NULL WHERE id IN (?, ?)').run(a.id, b.id)
    db.db.prepare('UPDATE messages SET ordering_origin = ? WHERE id = ?').run('local', b.id)
    db.markAsRead([a.id, b.id])
    bridge.resetForDatabaseChange()
    await rig.restartHostProcess()
    setStructuredAgentSessionHost(rig.host)
    bridge.resetForDatabaseChange()
    const unobserved = db.insertMessage({
      id: hostTestOperationId(),
      from: 'worker',
      to: 'consumer',
      subject: 'unobserved old source with no creation coverage'
    })
    db.db.prepare('UPDATE messages SET read = 0, handoff = ? WHERE id = ?').run(
      JSON.stringify({
        version: 1,
        kind: 'structured',
        operationId: hostTestOperationId(),
        manifest: { members: [b.id] }
      }),
      b.id
    )
    const sends = vi.spyOn(rig.host, 'send')
    const database = rig.host.deps.journalDatabase.db
    const originals = database
      .prepare(`SELECT * FROM journal_rows WHERE session_id = ?
    AND json_extract(row_json, '$.messageId') = ? AND json_extract(row_json, '$.change.op') = 'queued'`)
      .all(SESSION, oldId)
    expect(originals).toHaveLength(1)
    const saved = originals[0]!
    await rig.host.history({ sessionId: SESSION, direction: 'tail' })
    await journal().replaceEpochItems(
      'handle_forked',
      rig.store.getConversation(SESSION)?.currentFence ?? 1,
      []
    )
    expect(
      database
        .prepare('SELECT 1 FROM journal_rows WHERE session_id = ? AND epoch = ? AND seq = ?')
        .get(SESSION, saved.epoch, saved.seq)
    ).toBeUndefined()
    for (let n = 0; n < count; n++) {
      await journal().appendItem(
        { provider: 'orca', clientMessageId: `history-${n}` },
        { kind: 'status', text: `unrelated live history ${n}` },
        {
          fence: rig.store.getConversation(SESSION)?.currentFence ?? 1,
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        }
      )
    }
    bridge.deliverForHandle('consumer')
    await clock.observe(100)
    expect(sends).not.toHaveBeenCalled()
    expect(
      [a, b, unobserved].every((row) => db.getMessageById(row.id)?.delivered_at === null)
    ).toBe(true)
    expect(await rig.resume()).toMatchObject({ ok: true })
    await clock.observe(100)
    expect(sends).not.toHaveBeenCalled()
    // Recovery restores the actual original evidence; a human release never invents membership.
    const columns = Object.keys(saved)
    database
      .prepare(
        `INSERT INTO journal_rows (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`
      )
      .run(...columns.map((column) => saved[column]))
    bridge.resetForDatabaseChange()
    const membership = observeMailSqlWork(
      database,
      (sql) => sql.includes('SELECT row_json FROM journal_rows'),
      'row_json',
      'visits'
    )
    const receiptReads = vi.spyOn(rig.store, 'readCommandReceipt')
    bridge.deliverForHandle('consumer')
    await eventually(() =>
      expect([a, b].every((row) => db.getMessageById(row.id)?.delivered_at !== null)).toBe(true)
    )
    expect(membership.count()).toBeGreaterThanOrEqual(count)
    expect(membership.evaluatedBytes()).toBeGreaterThan(count * 100)
    expect(membership.count()).toBeLessThanOrEqual(
      Number(
        database.prepare('SELECT count(*) AS n FROM journal_rows WHERE session_id = ?').get(SESSION)
          ?.n
      )
    )
    expect(membership.calls).toHaveLength(1)
    expect(membership.calls.reduce((sum, call) => sum + call.bytes, 0)).toBeGreaterThan(0)
    expect(membership.calls.reduce((sum, call) => sum + call.bytes, 0)).toBeLessThan(10000)
    expect(receiptReads.mock.calls.filter(([, operation]) => operation === oldId)).toHaveLength(1)
    membership.verify()
    console.info(
      'legacy original-domain membership rows/bytes/arguments',
      JSON.stringify({
        count,
        examined: membership.count(),
        examinedJsonBytes: membership.evaluatedBytes(),
        calls: membership.calls
      })
    )
    membership.restore()
    expect(db.getMessageById(unobserved.id)).toMatchObject({ read: 0, delivered_at: null })
    expect(journal().queuedMessages.get(ordinaryMailCreationId(unobserved))).toBeNull()
    expect(sends).not.toHaveBeenCalled()
    expect(rig.store.readCommandReceipt({ kind: 'global' }, oldId)).toMatchObject({
      verdict: 'readable',
      receipt: { status: 'accepted' }
    })
  }
)

it('retains no-target birth across source reopen, qualifies real home imports, and protects lost original receipt coverage', async () => {
  const root = mailTestResources('mail-creation-lifetime-').directory()
  bridge.resetForDatabaseChange()
  db.close()
  const path = join(root, 'source.db')
  openMailQueueSource(path)
  await rig.workingSend()
  await rig.stop()
  const local = db.insertMessage({
    from: 'worker',
    to: 'not-native-yet',
    subject: 'pending before target'
  })
  expect(bridge.deliverForHandle('not-native-yet')).toBe(false)
  expect(
    db.db.prepare('SELECT creation_proof FROM messages WHERE id = ?').get(local.id)?.creation_proof
  ).toContain('unbound')
  expect(local).not.toHaveProperty('creation_proof')
  bridge.resetForDatabaseChange()
  db.close()
  openMailQueueSource(path)
  bridge.attachDatabase(db)
  const premature = vi.spyOn(rig.host, 'send')
  db.db.exec('BEGIN IMMEDIATE')
  db.db.prepare('UPDATE messages SET to_handle = ? WHERE id = ?').run('consumer', local.id)
  db.db.exec('ROLLBACK')
  await clock.observe(100)
  expect(premature).not.toHaveBeenCalled()
  expect(db.getMessageById(local.id)?.to_handle).toBe('not-native-yet')
  premature.mockRestore()
  // The actual table writer nominates an old ID; no manual delivery poke supplies this wake.
  db.db.prepare('UPDATE messages SET to_handle = ? WHERE id = ?').run('consumer', local.id)
  bridge.attachDatabase(db)
  const id = await card(local.id)
  await eventually(async () => expect(await rig.handoff(id)).toBeDefined())
  await complete(await rig.handoffId(id))
  const original = readMailCreationAuthority(rig.host.deps.journalDatabase.db)
  expect(original).not.toBeNull()
  expect(
    db.db.prepare('SELECT creation_proof FROM messages WHERE id = ?').get(local.id)?.creation_proof
  ).toContain(original!.storeId)

  const run = db.createRun({
    objective: 'genuine home',
    coordinatorHandle: null,
    coordinatorPaneKey: null
  })
  const task = db.createTask({ spec: 'remote report', runId: run.id })
  const { dispatch } = db.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: 3,
    taskId: task.id,
    startOptions: {},
    federation: {
      environmentId: 'peer',
      environmentName: 'peer',
      peerFingerprint: 'authenticated-peer',
      protocolVersion: 3
    }
  })
  expect(run).not.toHaveProperty('mail_creation_domain')
  bridge.resetForDatabaseChange()
  const missed = db.insertMessage({
    id: 'stable-missed-source',
    runId: run.id,
    from: 'worker',
    to: 'consumer',
    subject: 'already persisted missed source in genuine local Run',
    type: 'escalation'
  })
  expect(
    db.db.prepare('SELECT creation_proof FROM messages WHERE id = ?').get(missed.id)?.creation_proof
  ).toBeNull()
  db.close()
  openMailQueueSource(path)
  bridge.attachDatabase(db)
  bridge.deliverForHandle('consumer')
  const missedCard = await card(missed.id)
  await eventually(async () => expect(await rig.handoff(missedCard)).toBeDefined())
  await complete(await rig.handoffId(missedCard))
  expect(
    db.db.prepare('SELECT creation_proof FROM messages WHERE id = ?').get(missed.id)?.creation_proof
  ).toContain(original!.storeId)
  const imported = db.importFederatedRelayItem({
    dispatchId: dispatch.id,
    sequence: 1,
    message: {
      id: 'home-message',
      runId: run.id,
      from: 'remote-worker',
      to: 'consumer',
      subject: 'imported after home restart',
      body: 'one whole report',
      type: 'status',
      priority: 'normal'
    },
    lifecycle: { kind: 'none' }
  }).message
  expect(imported).not.toHaveProperty('creation_proof')
  bridge.attachDatabase(db)
  const importedId = await card(imported.id)
  expect(db.getMessageById(imported.id)?.ordering_origin).toBe('imported')
  expect(await rig.handoff(importedId)).toBeUndefined()
  expect(await rig.resume()).toMatchObject({ ok: true })
  await eventually(async () => expect(await rig.handoff(importedId)).toBeDefined())
  await complete(await rig.handoffId(importedId))

  // Actual authority destruction invalidates negative evidence, even with the same store UUID.
  rig.host.deps.journalDatabase.transaction((database) => {
    database.prepare('DELETE FROM agent_session_command_receipts WHERE operation_id = ?').run(id)
  })
  const changed = readMailCreationAuthority(rig.host.deps.journalDatabase.db)
  expect(changed?.storeId).toBe(original?.storeId)
  expect(changed?.coverageToken).not.toBe(original?.coverageToken)
  db.db.prepare('UPDATE messages SET delivered_at = NULL, read = 0 WHERE id = ?').run(local.id)
  const sends = vi.spyOn(rig.host, 'send')
  bridge.resetForDatabaseChange()
  bridge.deliverForHandle('consumer')
  await clock.observe(100)
  expect(sends).not.toHaveBeenCalled()
  expect(db.getMessageById(local.id)?.delivered_at).toBeNull()
  expect(await rig.resume()).toMatchObject({ ok: true })
  await clock.observe(100)
  expect(sends).not.toHaveBeenCalled()
})

it.each([100, 1000])(
  'keeps U=%i protected inputs cold for unrelated actual creates/preambles and wakes a former-domain member at its current READ route',
  async (count) => {
    await rig.workingSend()
    bridge.resetForDatabaseChange()
    const sources = db.insertMessages(
      Array.from({ length: count }, (_, n) => ({
        id: hostTestOperationId(),
        from: 'worker',
        to: 'consumer',
        subject: `protected-${n}`
      }))
    )
    const first = sources[0]!
    const receipt = vi.spyOn(rig.host.deps.store, 'readCommandReceipt')
    const body = vi.spyOn(db, 'getMessageById')
    const reads = observeMailSqlWork(
      db.db,
      (sql) =>
        sql.trimStart().startsWith('SELECT id, run_id, sequence, type') &&
        sql.includes('FROM messages'),
      'id'
    )
    bridge.deliverForHandle('consumer')
    await eventually(() => expect(reads.count()).toBe(count))
    await clock.observe(200)
    const baseline = {
      probes: reads.count(),
      body: body.mock.calls.length,
      receipts: receipt.mock.calls.length
    }
    const selections = vi.spyOn(MailDebts.prototype, 'select')
    const domainInventories = vi.spyOn(rig.host.deps.store, 'listConversations')
    const create = async (id: string) => {
      const params = createTestParams(undefined, {
        envelope: {
          sessionId: id,
          clientOperationId: hostTestOperationId(),
          expectedRuntimeFence: null,
          payloadFingerprint: '0'.repeat(64)
        }
      })
      expect(await rig.host.create({ callerKey: 'real-client' }, params)).toMatchObject({
        ok: true
      })
    }
    for (let n = 0; n < 10; n++) {
      const id = `unrelated-X-${n}`
      await create(id)
      expect(
        await sendAgentTurn({
          kind: 'structured-session',
          host: rig.host,
          sessionId: id,
          callerKey: `trusted-local:orchestration:dispatch-preamble-${n}`,
          turn: {
            body: hostTestMessage('Task preamble with no mail membership'),
            operationId: hostTestOperationId(),
            expectedRuntimeFence: rig.store.getRecord(id)!.lease.runtimeFence,
            delivery: 'queue',
            queueAlways: true
          }
        })
      ).toMatchObject({ kind: 'queued' })
      await clock.observe(20)
    }
    expect(reads.count()).toBe(baseline.probes)
    expect(body).toHaveBeenCalledTimes(baseline.body)
    expect(selections).not.toHaveBeenCalled()
    expect(domainInventories).not.toHaveBeenCalled()
    expect(db.getMessageById(first.id)?.delivered_at).toBeNull()
    const former = 'original-D'
    await create(former)
    const from = structuredMailSource({
      db,
      mailboxHandle: 'former-route',
      dispatchId: null,
      message: first,
      senderName: () => null
    })
    db.markAsRead([first.id])
    const sends = vi.spyOn(rig.host, 'send')
    expect(
      await sendAgentTurn({
        kind: 'structured-session',
        host: rig.host,
        sessionId: former,
        callerKey: 'trusted-local:orchestration:original-domain',
        turn: {
          body: { ...hostTestMessage('original saved report'), from },
          operationId: hostTestOperationId(),
          expectedRuntimeFence: rig.store.getRecord(former)!.lease.runtimeFence,
          delivery: 'queue',
          queueAlways: true
        }
      })
    ).toMatchObject({ kind: 'queued' })
    await eventually(() =>
      expect(db.getMessageById(first.id)).toMatchObject({
        read: 1,
        to_handle: 'consumer',
        delivered_at: expect.any(String)
      })
    )
    expect(sends).toHaveBeenCalledOnce()
    expect(journal().queuedMessages.get(ordinaryMailCreationId(first))).toBeNull()
    expect(db.getMessageById(sources[1]!.id)?.delivered_at).toBeNull()
    console.info(
      'original-domain-exact-work',
      JSON.stringify({
        count,
        baseline,
        finalProbes: reads.count(),
        calls: reads.calls,
        receiptsAfterNonmail: receipt.mock.calls.length - baseline.receipts
      })
    )
    reads.restore()
  }
)
