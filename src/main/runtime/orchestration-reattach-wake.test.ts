import { afterEach, describe, expect, it, vi } from 'vitest'
import { settledWriteStub } from '../providers/settled-pty-write-stub'
import { seedTerminalRestoreRecordsFromSpawnResult } from '../ipc/pty/pane/agent-session-owners'
import { agentHookServer } from '../agent-hooks/server'
import type { AgentStatusState } from '../../shared/agent-status-types'
import { OrcaRuntimeService } from './orca-runtime-test-mocks.spec'
import {
  InMemoryOrchestrationMessages,
  bindSinglePtyRun,
  setInMemoryOrchestrationMessages,
  store,
  syncSinglePty
} from './orca-runtime-test-fixtures.spec'

async function reattachQuietCoordinator(foreground: string, reported: AgentStatusState) {
  vi.spyOn(agentHookServer, 'readRestoredAgentStatus').mockResolvedValue(reported)
  const runtime = new OrcaRuntimeService(store)
  const db = new InMemoryOrchestrationMessages()
  const write = vi.fn().mockReturnValue(true)
  setInMemoryOrchestrationMessages(runtime, db)
  runtime.setPtyController({
    write,
    writeWithSettlement: settledWriteStub(write),
    kill: vi.fn(),
    getForegroundProcess: async () => foreground
  })
  syncSinglePty(runtime)
  const [terminal] = (await runtime.listTerminals()).terminals
  bindSinglePtyRun(db, terminal.handle)
  // The restarted runtime has seen nothing live from the surviving session.
  seedTerminalRestoreRecordsFromSpawnResult(runtime, { id: 'pty-1', isReattach: true })
  await vi.advanceTimersByTimeAsync(0)
  const message = db.insertMessage({ from: 'worker', to: terminal.handle, subject: 'worker_done' })
  runtime.notifyMessageArrived(terminal.handle, 'worker_done')
  // Past the readiness quiet window, so a refusal here is the gate's, not the clock's.
  await vi.advanceTimersByTimeAsync(5_000)
  db.close()
  return { write, message }
}

describe('restart wake for a quiet coordinator', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('wakes a surviving agent whose last report says its turn ended', async () => {
    vi.useFakeTimers()
    const { write, message } = await reattachQuietCoordinator('codex', 'done')
    expect(write).toHaveBeenCalledWith(
      'pty-1',
      expect.stringContaining('You have 1 orchestration message')
    )
    expect(message.delivered_at).toEqual(expect.any(String))
  })

  it('holds mail while the last report says a permission prompt is open', async () => {
    vi.useFakeTimers()
    const { write, message } = await reattachQuietCoordinator('codex', 'waiting')
    expect(write).not.toHaveBeenCalled()
    expect(message.delivered_at).toBeNull()
  })

  it('holds mail when a shell, not the reporting agent, holds the terminal', async () => {
    vi.useFakeTimers()
    const { write, message } = await reattachQuietCoordinator('zsh', 'done')
    expect(write).not.toHaveBeenCalled()
    expect(message.delivered_at).toBeNull()
  })
})
