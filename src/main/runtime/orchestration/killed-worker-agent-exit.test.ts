import { describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../shared/stable-pane-id'
import {
  createTranscriptPane,
  TRANSCRIPT_PANE_PTY_ID,
  type TranscriptPaneOptions
} from '../agent-transcript-pane-test-harness'
import { OrchestrationDb } from './db'
import type { RemoteDispatchAttachmentRow } from './types'

const PANE = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
const COMMAND_FINISHED = '\x1b]133;D;0\x07'
const NESTED_SHELL_COMMAND = '\x1b]133;C\x07ls\r\n\x1b]133;D;0\x07'

async function startWorkerPane() {
  const options: TranscriptPaneOptions = {
    paneTitle: 'Worker',
    foregroundProcess: 'codex',
    launchAgent: 'codex',
    data: '',
    shellForegroundProven: false
  }
  const { runtime, handle } = await createTranscriptPane(options)
  const db = new OrchestrationDb(':memory:')
  runtime.setOrchestrationDb(db)
  const settle = async () => {
    await runtime.readTerminal(handle)
    await new Promise((resolve) => setImmediate(resolve))
  }
  return { runtime, handle, db, options, settle }
}

describe('a terminal worker whose agent died while its shell lives', () => {
  it('reports once only after the shell is proven alone, not on a nested shell completion', async () => {
    const { runtime, handle, db, options, settle } = await startWorkerPane()
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
      processIncarnation: 'inc-1',
      worktreeId: 'wt-1',
      effects: [],
      setupState: 'skipped'
    })
    db.markWorkerDispatchReady(dispatch.id)
    const mail = () =>
      db.getUnreadRunMailbox(run.id, 100, ['escalation']).map((message) => message.subject)
    try {
      // The agent lives: a nested interactive shell's completion is not its exit.
      runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, NESTED_SHELL_COMMAND, 1)
      await settle()
      expect(mail()).toEqual([])

      options.shellForegroundProven = true
      runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, COMMAND_FINISHED, 2)
      runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, COMMAND_FINISHED, 3)
      await settle()
      expect(mail()).toEqual(['Worker exited without reporting'])
      expect(db.getDispatchContextById(dispatch.id)?.status).toBe('dispatched')
    } finally {
      db.close()
    }
  })

  it("gives a paired-server worker's agent exit and its later PTY exit one report", async () => {
    const { runtime, db, options, settle } = await startWorkerPane()
    const attachment: RemoteDispatchAttachmentRow = {
      home_run_id: 'run_home',
      dispatch_id: 'dsp_remote',
      task_id: 'task_remote',
      home_peer_fingerprint: 'home',
      protocol_version: 1,
      runtime_epoch: 'epoch',
      capability_hash: null,
      pane_key: PANE,
      process_incarnation: 'inc-1',
      state: 'ready',
      stage: 'ready',
      worktree_id: 'wt-1',
      terminal_handle: null,
      setup_state: 'skipped',
      effects: '[]',
      residual_resources: '[]',
      to_worker_imported_sequence: 0,
      depth: 1,
      consumer_generation: 0,
      last_error: null,
      created_at: '',
      updated_at: ''
    }
    vi.spyOn(db, 'findActiveRemoteAttachmentForPane').mockImplementation((paneKey) =>
      paneKey === PANE ? attachment : undefined
    )
    vi.spyOn(db, 'isRemoteAttachmentProcessCurrent').mockReturnValue(true)
    const relay = vi.spyOn(db, 'enqueueFederationRelay')
    try {
      options.shellForegroundProven = true
      runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, COMMAND_FINISHED, 1)
      await settle()
      runtime.onPtyExit(TRANSCRIPT_PANE_PTY_ID, 0)
      await settle()
      const ids = relay.mock.calls.map(([params]) => params.messageId)
      expect(ids).toHaveLength(2)
      expect(new Set(ids).size).toBe(1)
    } finally {
      db.close()
    }
  })
})
