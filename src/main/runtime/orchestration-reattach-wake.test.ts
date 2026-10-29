import { afterEach, describe, expect, it, vi } from 'vitest'
import { settledWriteStub } from '../providers/settled-pty-write-stub'
import { seedTerminalRestoreRecordsFromSpawnResult } from '../ipc/pty/pane/agent-session-owners'
import { agentHookServer } from '../agent-hooks/server'
import { OrcaRuntimeService } from './orca-runtime-test-mocks.spec'
import {
  InMemoryOrchestrationMessages,
  bindSinglePtyRun,
  setInMemoryOrchestrationMessages,
  store,
  syncSinglePty
} from './orca-runtime-test-fixtures.spec'

type RestoredReport = Awaited<ReturnType<typeof agentHookServer.readRestoredAgentStatus>>

async function reattachQuietCoordinator(
  report: RestoredReport,
  {
    foreground = 'codex',
    screen
  }: {
    foreground?: string
    screen?: string
  } = {}
) {
  const runtime = new OrcaRuntimeService(store)
  vi.spyOn(agentHookServer, 'readRestoredAgentStatus').mockResolvedValue(report)
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
  if (screen) {
    runtime.onPtyData('pty-1', screen, Date.now())
  }
  // The restarted runtime has seen no status from the surviving session.
  seedTerminalRestoreRecordsFromSpawnResult(runtime, { id: 'pty-1', isReattach: true })
  await vi.advanceTimersByTimeAsync(0)
  const message = db.insertMessage({ from: 'worker', to: terminal.handle, subject: 'worker_done' })
  runtime.notifyMessageArrived(terminal.handle, 'worker_done')
  // Past the readiness quiet window, so a refusal here is the gate's, not the clock's.
  await vi.advanceTimersByTimeAsync(5_000)
  db.close()
  const woken = write.mock.calls.some(([, data]) =>
    String(data).includes('You have 1 orchestration message')
  )
  return { woken, message }
}

describe('restart wake for a quiet coordinator', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('wakes a surviving agent whose last report says its turn ended', async () => {
    vi.useFakeTimers()
    const { woken, message } = await reattachQuietCoordinator({ state: 'done' })
    expect(woken).toBe(true)
    expect(message.delivered_at).toEqual(expect.any(String))
  })

  it("reads the lead's own ended turn under still-running background work", async () => {
    vi.useFakeTimers()
    const { woken } = await reattachQuietCoordinator({
      state: 'working',
      mainAgent: { state: 'done', stateStartedAt: 1 }
    })
    expect(woken).toBe(true)
  })

  it.each([
    ['a permission prompt is open', { state: 'waiting' } as const, {}],
    [
      'a shell, not the reporting agent, holds the terminal',
      { state: 'done' } as const,
      {
        foreground: 'zsh'
      }
    ],
    [
      'text typed before the restart is still unsent',
      { state: 'done' } as const,
      { screen: `${'─'.repeat(40)}\r\n❯ please refactor the auth` }
    ]
  ])('holds mail when %s', async (_case, report, options) => {
    vi.useFakeTimers()
    const { woken, message } = await reattachQuietCoordinator(report, options)
    expect(woken).toBe(false)
    expect(message.delivered_at).toBeNull()
  })
})
