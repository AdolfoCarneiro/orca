import './rpc/unused-default-rpc-methods.test-fixture'
import { expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../shared/agent-session-journal-types'
import { formatOrcaSessionAddress } from '../../shared/orca-session-address'
import { testOrcaSessionId } from '../../shared/orca-session-address-test-fixture'
import { createRootDispatch } from './orchestration/db/root-dispatch-test-fixture'
import { dispatchTaskSource } from './orchestration/dispatch-task-source'
import { observeMailSqlWork } from './orchestration/mail-sql-work.test-support'
import { readMailCreationHistory } from './orchestration/structured-mail-creation-history'
import {
  hostTestMessage,
  hostTestOperationId
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { structuredMailSource } from './orchestration/structured-mail-source'
import { sendAgentTurn } from './orchestration/send-agent-turn'
import { sendChatTask } from './rpc/methods/orchestration/chat-task-delivery'
import {
  COORDINATOR,
  PEER_CHAT,
  WAIT,
  coordinatorRunAndTask,
  db,
  host,
  observationClock,
  openChat,
  sendUserMessage,
  settleTurn
} from './structured-chat-coordinator-mail-rig.test-fixture'

it.each([100, 1000])(
  'real busy chat-task commits avoid retained-history scans at N=%i and drain through ordinary full turns',
  async (count) => {
    await openChat(COORDINATOR)
    const worker = await openChat(PEER_CHAT)
    const { runId } = await coordinatorRunAndTask()
    expect(await sendUserMessage(PEER_CHAT, 'current work before the new tasks')).toMatchObject({
      ok: true
    })
    await vi.waitFor(() => expect(worker.turns).toHaveLength(1), WAIT)
    const journal = host.collaboratorsForTests().sessions.get(PEER_CHAT)!.journal
    for (let n = 0; n < count; n++) {
      await journal.appendItem(
        { provider: 'orca', clientMessageId: `populated-X-${n}` },
        { kind: 'status', text: `retained preamble history ${n}` },
        { fence: host.currentFence(PEER_CHAT)!, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
    }
    const retained = db.insertMessages(
      Array.from({ length: count }, (_, n) => ({
        id: `retained-member-${n}`,
        runId,
        from: 'old-worker',
        to: 'retained-legacy',
        subject: 'old accepted member'
      }))
    )
    db.markAsRead(retained.map((source) => source.id))
    const from = structuredMailSource({
      db,
      mailboxHandle: 'retained-legacy',
      dispatchId: null,
      message: retained[0]!,
      senderName: () => null
    })
    if (from.orchestration?.message !== 'mail-notice') {
      throw new Error('missing original batch attribution')
    }
    expect(await sendUserMessage(COORDINATOR, 'current coordinator work')).toMatchObject({
      ok: true
    })
    expect(
      await sendAgentTurn({
        kind: 'structured-session',
        host,
        sessionId: COORDINATOR,
        callerKey: 'trusted-local:orchestration:retained-batch',
        turn: {
          body: {
            ...hostTestMessage('accepted legacy batch'),
            from: {
              ...from,
              orchestration: {
                ...from.orchestration,
                messages: retained.map((source) => ({
                  runId: source.run_id,
                  messageId: source.id,
                  from: source.from_handle
                }))
              }
            }
          },
          operationId: hostTestOperationId(),
          expectedRuntimeFence: host.currentFence(COORDINATOR)!,
          delivery: 'queue',
          queueAlways: true
        }
      })
    ).toMatchObject({ kind: 'queued' })
    // Cold locator work is measured in the file-backed original-history scenario, separately.
    expect(readMailCreationHistory(host, COORDINATOR).members.size).toBe(count)
    const database = host.deps.journalDatabase.db
    const census = vi.spyOn(database, 'prepare')
    const originals = observeMailSqlWork(
      database,
      (sql) =>
        sql.replace(/\s+/g, ' ').trim() ===
        'SELECT row_json FROM journal_rows WHERE session_id = ? AND epoch = ? AND seq = ?',
      'row_json'
    )
    try {
      for (let k = 0; k < 3; k++) {
        const task = db.createTask({ runId, spec: `actual task ${k}` })
        const dispatch = createRootDispatch(
          db,
          task.id,
          formatOrcaSessionAddress(testOrcaSessionId(PEER_CHAT))
        )
        expect(
          await sendChatTask({
            db,
            dispatch,
            from: dispatchTaskSource({
              db,
              dispatch,
              from: `run:${runId}`,
              senderName: () => null
            }),
            preamble: `new task preamble ${k}`
          })
        ).toBe('queued')
        await observationClock.observe(30)
      }
      expect(
        census.mock.calls.filter(([sql]) =>
          sql.startsWith('SELECT session_id, epoch, seq, row_json FROM journal_rows')
        )
      ).toHaveLength(0)
      expect(originals.count()).toBeLessThanOrEqual(12)
      const queued = journal.queuedMessages.list().filter((card) => card.status === 'waiting')
      expect(queued).toHaveLength(3)
      expect(worker.turns).toHaveLength(1)
      const hot = {
        count,
        tasks: 3,
        originalRows: originals.count(),
        originalBytes: originals.evaluatedBytes()
      }
      console.info('actual-chat-task-history-work', JSON.stringify(hot))
      originals.verify()
      // These are real ordinary cards, not mail-specific work held in a parallel list.
      await settleTurn(PEER_CHAT, 0, 'completed')
      for (let k = 1; k <= 3; k++) {
        await vi.waitFor(() => expect(worker.turns).toHaveLength(k + 1), WAIT)
        await observationClock.observe(30)
        expect(worker.turns).toHaveLength(k + 1)
        await settleTurn(PEER_CHAT, k, 'completed')
      }
    } finally {
      originals.restore()
      census.mockRestore()
    }
  }
)
