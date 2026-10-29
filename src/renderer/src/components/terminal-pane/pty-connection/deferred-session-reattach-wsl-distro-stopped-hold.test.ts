// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerAgentStatusStartupSnapshot } from '@/hooks/ipc-events/agent-status-startup-snapshot'
import {
  noteUserWorkspaceSwitch,
  resetWorkspaceSwitchUserActsForTests
} from '@/lib/workspace-switch-user-act'
import { wslDistroStoppedHoldMessage } from '../../../../../shared/wsl-distro-stopped-hold'
import {
  startHeldPanesForWslDistro,
  wslDistroStoppedHoldStore
} from '../wsl-distro-stopped-hold-state'
import { startDeferredSessionReattach } from './deferred-session-reattach-connect'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

vi.mock('../terminal-lifecycle-diagnostics', () => ({ warnTerminalLifecycleAnomaly: vi.fn() }))
vi.mock('./pty-connect-limits', () => ({
  recordPtyConnectDiagnostic: vi.fn(),
  isSshSessionGoneError: () => false
}))

const HOLD = `Error invoking remote method 'pty:spawn': Error: ${wslDistroStoppedHoldMessage('Ubuntu')}`

function createSession(opts: { runtimeEnvironmentId?: string } = {}) {
  let onError: (message: string) => void = () => {}
  let next: 'hold' | 'reattach' = 'hold'
  const transport = {
    connect: vi.fn(async (_options: Record<string, unknown>) => {
      if (next === 'hold') {
        onError(HOLD)
        return undefined
      }
      return { id: 'restored-pty', coldRestore: { scrollback: 'x', cwd: '/', cols: 80, rows: 24 } }
    }),
    getPtyId: () => null
  }
  const fixture = {
    pane: { id: 1, leafId: 'leaf', terminal: { options: { disableStdin: false } } },
    transport,
    disposed: false,
    transportStreamGeneration: 1,
    runtimeEnvironmentId: opts.runtimeEnvironmentId ?? null,
    waitTeardowns: new Array<() => void>(),
    writeReplayData: vi.fn(),
    deps: {
      restoredViewportBlankingPanesRef: { current: new Set<number>() },
      tabId: 'tab',
      worktreeId: 'wt',
      paneTransportsRef: { current: new Map([[1, transport]]) },
      isVisibleRef: { current: true },
      clearTabPtyId: vi.fn()
    },
    buildColdRestoreAgentResumeStartup: () => null,
    captureTransportOutputCallbacks: (reportError: (message: string) => void) => {
      onError = reportError
      return { generation: 1, callbacks: {} }
    },
    beginReattachLiveDataDeferral: vi.fn(),
    finishReattachLiveDataDeferral: vi.fn(),
    shouldDeclareHiddenAtSpawn: () => false,
    mergeStartupEnvWithPaneIdentity: (env: Record<string, string>) => env,
    handleReattachResult: vi.fn().mockResolvedValue(true),
    clearExitedPanePtyLayoutBinding: vi.fn(),
    startFreshColdRestoreAgentResume: vi.fn().mockResolvedValue('fresh-pty'),
    reportError: vi.fn(),
    cols: 80,
    rows: 24,
    cacheKey: 'tab:leaf'
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture provides every session field read by deferred reattach and the hold.
  const session = fixture as unknown as ConnectPanePtySession
  return { fixture, session, transport, nextConnect: (mode: typeof next) => (next = mode) }
}

const heldDistro = (): string | null =>
  wslDistroStoppedHoldStore.getState().panes['tab:leaf']?.distro ?? null

describe('a restored WSL bridge pane whose distro is stopped (E9)', () => {
  let bridge: ReturnType<typeof registerAgentStatusStartupSnapshot>
  beforeEach(() => {
    vi.clearAllMocks()
    resetWorkspaceSwitchUserActsForTests()
    wslDistroStoppedHoldStore.setState({ panes: {} })
    bridge = registerAgentStatusStartupSnapshot()
    bridge.settle()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        pty: {
          declarePendingPaneSerializer: vi.fn().mockResolvedValue(null),
          readNewerDaemonHeldScreen: vi
            .fn()
            .mockResolvedValue({ scrollback: 'old output', cols: 80, rows: 24 })
        }
      }
    })
  })
  afterEach(() => bridge.dispose())

  it('asks main for a passive restore at launch, and is held read-only with its saved screen', async () => {
    const { fixture, session, transport } = createSession()
    startDeferredSessionReattach(session, 'restored-pty')
    await vi.waitFor(() => expect(heldDistro()).toBe('Ubuntu'))
    expect(transport.connect).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'restored-pty', wslPassiveRestore: true })
    )
    expect(fixture.pane.terminal.options.disableStdin).toBe(true)
    await vi.waitFor(() => expect(fixture.writeReplayData).toHaveBeenCalledWith('old output'))
    // A hold is not a failure: no error toast, and no fresh shell that would start the distro.
    expect(fixture.reportError).not.toHaveBeenCalled()
    expect(fixture.startFreshColdRestoreAgentResume).not.toHaveBeenCalled()
  })

  it("reconnects as the user's act once Start is pressed", async () => {
    const { fixture, session, transport, nextConnect } = createSession()
    startDeferredSessionReattach(session, 'restored-pty')
    await vi.waitFor(() => expect(heldDistro()).toBe('Ubuntu'))
    nextConnect('reattach')

    startHeldPanesForWslDistro('ubuntu')

    await vi.waitFor(() => expect(transport.connect).toHaveBeenCalledTimes(2))
    expect(transport.connect.mock.calls[1]?.[0]).not.toHaveProperty('wslPassiveRestore')
    expect(heldDistro()).toBeNull()
    expect(fixture.pane.terminal.options.disableStdin).toBe(false)
  })

  it("sends the user's last switch, so main can tell it from a later remount", async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000)
    noteUserWorkspaceSwitch('wt')
    vi.mocked(Date.now).mockRestore()
    const { session, transport, nextConnect } = createSession()
    nextConnect('reattach')
    startDeferredSessionReattach(session, 'restored-pty')
    await vi.waitFor(() => expect(transport.connect).toHaveBeenCalled())
    expect(transport.connect.mock.calls[0]?.[0]).toMatchObject({ wslUserSwitchAt: 1_000 })
    expect(transport.connect.mock.calls[0]?.[0]).not.toHaveProperty('wslPassiveRestore')
  })

  it("never marks a paired server's pane: its host decides its own starts", async () => {
    const { session, transport, nextConnect } = createSession({
      runtimeEnvironmentId: 'wsl:ubuntu'
    })
    nextConnect('reattach')
    startDeferredSessionReattach(session, 'restored-pty')
    await vi.waitFor(() => expect(transport.connect).toHaveBeenCalled())
    expect(transport.connect.mock.calls[0]?.[0]).not.toHaveProperty('wslPassiveRestore')
  })
})
