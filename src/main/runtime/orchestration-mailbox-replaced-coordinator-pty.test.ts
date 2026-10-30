import './rpc/unused-default-rpc-methods.test-fixture'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from './orchestration/db'
import {
  createRuntime,
  driveToLiveIdle,
  PANE_KEY,
  pointerCount
} from './orchestration-mailbox-notification-test-harness'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()), isPackaged: false },
  BrowserWindow: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn(() => null) }
}))

describe('Run mail for a coordinator pane whose PTY was replaced', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('wakes the pane coordinator of a Run created under the PTY a restart replaced', async () => {
    vi.useFakeTimers()
    const db = new OrchestrationDb(':memory:')
    const harness = createRuntime(db)
    const run = db.createRun({
      objective: 'Run from the previous PTY',
      coordinatorHandle: 'term_previous_pty_in_pane',
      coordinatorPaneKey: PANE_KEY
    })
    await driveToLiveIdle(harness.runtime)

    db.insertMessage({
      from: 'term_worker',
      to: `run:${run.id}`,
      subject: 'Worker done',
      type: 'worker_done',
      runId: run.id
    })
    harness.runtime.notifyMessageArrived(`run:${run.id}`, 'worker_done')
    await vi.advanceTimersByTimeAsync(500)

    expect(pointerCount(harness.write)).toBe(1)
    db.close()
  })
})
