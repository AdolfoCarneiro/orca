import { describe, expect, it } from 'vitest'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { agentLaunchTokenHash, launchExitReceiptId } from '../../agent-launch/agent-launch-token'
import { createTranscriptPane, TRANSCRIPT_PANE_PTY_ID } from '../agent-transcript-pane-test-harness'
import { registerBoundPty } from '../bind-first-pane.test-fixture'
import { OrchestrationDb } from './db'

const PANE = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
const receiptId = (launchToken: string) => launchExitReceiptId(agentLaunchTokenHash(launchToken))
const receipt = (launchToken: string) => `\x1b]7503;orca-launch-exit;${receiptId(launchToken)}\x07`

async function createWorkerPane(options: { launchAgent?: 'codex'; launchTokenHash?: string }) {
  const { runtime, handle } = await createTranscriptPane({
    paneTitle: 'Worker',
    foregroundProcess: 'codex',
    data: '',
    ...options
  })
  const db = new OrchestrationDb(':memory:')
  runtime.setOrchestrationDb(db)
  const run = db.createRun({
    objective: 'o',
    coordinatorHandle: 'term_coordinator',
    coordinatorPaneKey: makePaneKey('tab-coordinator', '22222222-2222-4222-8222-222222222222')
  })
  const task = db.createTask({ spec: 'work', runId: run.id })
  const { dispatch } = db.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: Number.MAX_SAFE_INTEGER,
    taskId: task.id,
    startOptions: {}
  })
  db.prepareStartingWorkerAuthority({
    dispatchId: dispatch.id,
    handle,
    paneKey: PANE,
    processIncarnation: runtime.getTerminalProcessIncarnation(handle),
    launchTokenHash: options.launchTokenHash,
    worktreeId: 'wt-1',
    effects: [],
    setupState: 'skipped'
  })
  db.markWorkerDispatchReady(dispatch.id)
  const mail = () =>
    db.getUnreadRunMailbox(run.id, 100, ['escalation']).map((message) => message.subject)
  let seq = 0
  const output = (data: string) => runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, data, ++seq)
  return { runtime, db, dispatch, mail, output }
}

describe('a terminal worker whose agent died while its shell lives', () => {
  it("reports its current launch's exit receipt once; nested, forged and stale receipts do not", async () => {
    const { runtime, db, dispatch, mail, output } = await createWorkerPane({ launchAgent: 'codex' })
    try {
      // A nested shell's completion, another launch's receipt, and the echoed launch line are not this agent's exit.
      output('\x1b]133;C\x07ls\r\n\x1b]133;D;0\x07')
      output(receipt('another-launch'))
      output(`printf '\\033]7503;orca-launch-exit;${receiptId('transcript-launch')}\\007'`)
      expect(mail()).toEqual([])

      // The old prompt returns and a relaunch binds a new token: the old launch's receipt is stale.
      output('\x1b]133;D;0\x07')
      registerBoundPty(runtime, TRANSCRIPT_PANE_PTY_ID, 'wt-1', null, {
        tabId: 'tab-1',
        leafId: '11111111-1111-4111-8111-111111111111',
        incarnationId: 'inc-1',
        agentLaunchAuthority: { launchToken: 'relaunch', launchAgent: 'codex' }
      })
      output(receipt('transcript-launch'))
      expect(mail()).toEqual([])

      output(receipt('relaunch'))
      output(receipt('relaunch'))
      expect(mail()).toEqual(['Worker exited without reporting'])
      expect(db.getDispatchContextById(dispatch.id)?.status).toBe('dispatched')

      // The shell's own later exit settles the Dispatch without a second report.
      runtime.onPtyExit(TRANSCRIPT_PANE_PTY_ID, 0)
      expect(mail()).toEqual(['Worker exited without reporting'])
      expect(db.getDispatchContextById(dispatch.id)?.status).not.toBe('dispatched')
    } finally {
      // Let the report's coordinator wake-up run before the database closes.
      await new Promise((resolve) => setImmediate(resolve))
      db.close()
    }
  })
  it("reports a worker reattached after restart from its Dispatch's launch commitment", async () => {
    // A reattached PTY holds no launch token; its Dispatch persisted the commitment before the restart.
    const { db, mail, output } = await createWorkerPane({
      launchTokenHash: agentLaunchTokenHash('transcript-launch')
    })
    try {
      output(receipt('another-launch'))
      expect(mail()).toEqual([])
      output(receipt('transcript-launch'))
      output(receipt('transcript-launch'))
      expect(mail()).toEqual(['Worker exited without reporting'])
    } finally {
      await new Promise((resolve) => setImmediate(resolve))
      db.close()
    }
  })
})
