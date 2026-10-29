import './mock-descendant-sweep'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import type * as DistroGate from '../wsl-background-distro-gate'
import type { DaemonServer } from './daemon-server'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import { createMockSubprocess, startDaemonAdapterHarness } from './daemon-pty-adapter-test-harness'
import { parseWslDistroStoppedHold } from '../../shared/wsl-distro-stopped-hold'
import {
  _resetWslBackgroundDistroGateForTests,
  noteWslDistroMayHaveStopped
} from '../wsl-background-distro-gate'

const readState = vi.hoisted(() =>
  vi.fn(
    async (_distro: string, _opts?: unknown): Promise<'running' | 'stopped' | 'unverifiable'> =>
      'stopped'
  )
)
vi.mock('../wsl-background-distro-gate', async (importOriginal) => ({
  ...(await importOriginal<typeof DistroGate>()),
  readWslDistroRunningState: readState
}))

const WSL_CWD = '\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo'
const SESSION_ID = 'wt-1::/home/jin/repo@@pane1'

describe('a passive restore of a WSL bridge pane (E9)', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')
  let dir: string
  let server: DaemonServer
  let adapter: DaemonPtyAdapter
  let spawns: number

  beforeEach(async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    _resetWslBackgroundDistroGateForTests()
    readState.mockReset()
    readState.mockResolvedValue('stopped')
    spawns = 0
    const harness = await startDaemonAdapterHarness(() => {
      spawns++
      return createMockSubprocess()
    })
    ;({ dir, server, adapter } = harness)
  })

  afterEach(async () => {
    if (platform) {
      Object.defineProperty(process, 'platform', platform)
    }
    adapter.dispose()
    await server.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  // A fixed wall clock for the stop note, which the user's switch time is ordered against.
  const noteStopAt = (wallMs: number): void => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(wallMs)
    noteWslDistroMayHaveStopped('Ubuntu')
    now.mockRestore()
  }

  const restore = (
    extra: { wslPassiveRestore?: true; wslUserSwitchAt?: number; isNewSession?: boolean } = {}
  ) => adapter.spawn({ cols: 80, rows: 24, cwd: WSL_CWD, sessionId: SESSION_ID, ...extra })

  it('is held, starting nothing, when a settled read confirms the distro stopped', async () => {
    const error = await restore({ wslPassiveRestore: true }).catch((caught: unknown) => caught)
    expect(error instanceof Error ? parseWslDistroStoppedHold(error.message) : null).toBe('Ubuntu')
    expect(spawns).toBe(0)
    expect(readState).toHaveBeenCalledWith('Ubuntu', { retryUnverifiable: true })
  })

  it.each(['running', 'unverifiable'] as const)(
    'starts as before when the read says %s: only a confirmed stop holds it',
    async (state) => {
      readState.mockResolvedValue(state)
      await restore({ wslPassiveRestore: true })
      expect(spawns).toBe(1)
    }
  )

  it("starts a user's restore and a new terminal without reading the distro", async () => {
    await restore()
    await adapter.spawn({
      cols: 80,
      rows: 24,
      cwd: WSL_CWD,
      isNewSession: true,
      wslPassiveRestore: true
    })
    expect(spawns).toBe(2)
    expect(readState).not.toHaveBeenCalled()
  })

  // The user opened the workspace, its distro stopped later, then Orca remounted the pane.
  it('holds a remount after the distro stopped, though the user switched to it before the stop', async () => {
    noteStopAt(2_000)

    const error = await restore({ wslUserSwitchAt: 1_000 }).catch((caught: unknown) => caught)

    expect(error instanceof Error ? parseWslDistroStoppedHold(error.message) : null).toBe('Ubuntu')
    expect(spawns).toBe(0)
  })

  it("starts a restore the user's switch after the stop asked for, without reading the distro", async () => {
    noteStopAt(2_000)
    await restore({ wslUserSwitchAt: 3_000 })
    expect(spawns).toBe(1)
    expect(readState).not.toHaveBeenCalled()
  })

  it('leaves a non-WSL restore alone', async () => {
    await adapter.spawn({
      cols: 80,
      rows: 24,
      cwd: 'C:\\repo',
      sessionId: 'wt-1::C:/repo@@pane1',
      wslPassiveRestore: true
    })
    expect(spawns).toBe(1)
    expect(readState).not.toHaveBeenCalled()
  })
})
