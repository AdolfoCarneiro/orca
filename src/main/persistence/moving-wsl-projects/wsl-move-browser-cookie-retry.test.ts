import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CdpCookie } from '../../browser/browser-cdp-cookie'

type FakeSession = { partition: string; cookies: { flushStore: () => Promise<void> } }
type Target = { partition: string; hidden: boolean; destroyed: boolean; attached: boolean }
const electron = vi.hoisted(() => {
  const targets: Target[] = []
  const reads: string[] = []
  const writes: string[] = []
  const flushed: string[] = []
  return {
    jars: new Map<string, CdpCookie[]>(),
    sessions: new Map<string, FakeSession>(),
    targets,
    reads,
    writes,
    flushed,
    commandDelay: 9000,
    failSourceReads: 0
  }
})
vi.mock('electron', () => ({
  BrowserWindow: class {
    readonly state: Target
    readonly webContents
    constructor(options: { show?: boolean; webPreferences: { session: FakeSession } }) {
      const partition = options.webPreferences.session.partition
      const state = { partition, hidden: options.show === false, destroyed: false, attached: false }
      this.state = state
      electron.targets.push(state)
      this.webContents = {
        isDestroyed: () => state.destroyed,
        debugger: {
          isAttached: () => state.attached,
          attach: () => {
            state.attached = true
          },
          detach: () => {
            state.attached = false
          },
          sendCommand: async (method: string, params: Record<string, unknown> = {}) => {
            if (method === 'Network.getAllCookies') {
              if (partition === SOURCE && electron.failSourceReads > 0) {
                electron.failSourceReads -= 1
                throw new Error('source read failed')
              }
              const cookies = structuredClone(electron.jars.get(partition) ?? [])
              electron.reads.push(partition)
              return { cookies }
            }
            if (method !== 'Network.setCookie') {
              throw new Error(`unexpected command ${method}`)
            }
            // ast-grep-ignore: test-no-real-time-wait -- Only advanced by the test's fake clock.
            await new Promise<void>((resolve) => setTimeout(resolve, electron.commandDelay))
            if (state.destroyed) {
              throw new Error('target destroyed before finite command finished')
            }
            const destination = electron.jars.get(partition)
            if (!destination) {
              throw new Error('destination jar missing')
            }
            const source = electron.jars.get(SOURCE)?.find((cookie) => cookie.name === params.name)
            if (!source) {
              throw new Error('source identity missing')
            }
            destination.push(structuredClone(source))
            electron.writes.push(source.name)
            return { success: true }
          }
        }
      }
    }
    async loadURL(): Promise<void> {}
    destroy(): void {
      this.state.destroyed = true
    }
  },
  session: {
    fromPartition: (partition: string): FakeSession => {
      let target = electron.sessions.get(partition)
      if (!target) {
        target = {
          partition,
          cookies: {
            flushStore: async () => {
              electron.flushed.push(partition)
            }
          }
        }
        electron.sessions.set(partition, target)
      }
      return target
    }
  }
}))
vi.mock('../../browser/browser-session-registry', () => ({ browserSessionRegistry: {} }))
vi.mock('../../browser/browser-session-startup', () => ({ browserSessionsInitialized: vi.fn() }))
vi.mock('../../browser/browser-route-partition-binding-runtime', () => ({
  activeBrowserRoutePartitionOrcaProfileId: vi.fn(),
  currentBrowserRoutePartitionBindingStore: vi.fn()
}))
vi.mock('../../../shared/runtime-environment-store', () => ({ listEnvironments: vi.fn() }))
vi.mock('./wsl-move-undo-host-automations', () => ({
  retryWslMoveHostAutomationsLeftOff: vi.fn()
}))

import {
  copyBrowserPartitionCookies,
  flushBrowserPartitionCookies
} from '../../browser/browser-partition-cookie-copy'
import { WSL_HOSTS_INTERNAL_GATE_ENV } from '../../../shared/wsl-host-internal-gate'
import { WSL_MOVE_BROWSER_COOKIES_STORE_ID } from '../../../shared/wsl-move/wsl-move-browser-cookie-copy'
import { wslMoveCutoverFixture as cutover } from '../__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from '../__fixtures__/wsl-mover/wsl-move-journal-seeding'
import { wslHostBrowserRouteStorage } from '../../browser/wsl-host-browser-route-partition'
import { registerWslMoveBrowserCookieStore } from './wsl-move-browser-cookie-store'
import { runGatedWslMoveDesktopRewritePass } from './wsl-move-desktop-rewrite'
import { listWslMoveCutovers } from './wsl-move-cutover-journal'
import { resetWslMoveDesktopRewriteStoresForTests } from './wsl-move-desktop-rewrite-stores'
import {
  cancelWslMoveRewriteRetryForTests,
  scheduleWslMoveRewriteRetry
} from './wsl-move-rewrite-retry'
import { configureWslHostsGate, resetWslHostsGateForTests } from '../../wsl/wsl-host-gate'

const SOURCE = 'persist:orca-browser-default'
const DESTINATION = `persist:orca-browser-v1-${'a'.repeat(64)}`
let userDataPath: string
let elapsed: number

async function advanceTo(milliseconds: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(milliseconds - elapsed)
  elapsed = milliseconds
}

function snapshot() {
  const targets = electron.targets.filter((target) => !target.destroyed)
  return {
    elapsed,
    liveTargets: targets.length,
    sourceTargets: targets.filter((target) => target.partition === SOURCE).length,
    destinationTargets: targets.filter((target) => target.partition === DESTINATION).length,
    sourceReads: electron.reads.filter((partition) => partition === SOURCE).length,
    destinationCookies: electron.jars.get(DESTINATION)?.length,
    writes: electron.writes.length,
    flushed: [...electron.flushed],
    ledger: listWslMoveCutovers(userDataPath)[0]?.rewrittenStores,
    phase: listWslMoveCutovers(userDataPath)[0]?.phase
  }
}

beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-wsl-cookie-copy-proof-'))
  elapsed = 0
  vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  electron.jars.clear()
  electron.sessions.clear()
  electron.targets.length = 0
  electron.reads.length = 0
  electron.writes.length = 0
  electron.flushed.length = 0
  electron.commandDelay = 9000
  electron.failSourceReads = 0
  electron.jars.set(DESTINATION, [])
  registerWslMoveBrowserCookieStore({
    userDataPath,
    sessionsReady: () => true,
    orcaProfileId: () => 'orca-profile-a',
    listEnvironments: () => [
      {
        id: 'wsl:Ubuntu',
        name: 'Ubuntu',
        createdAt: 1,
        updatedAt: 1,
        lastUsedAt: null,
        runtimeId: null,
        pairingRevision: 1,
        orcadDeployment: { kind: 'wsl', distro: 'Ubuntu', localPort: 41001, remotePort: 6768 },
        preferredEndpointId: 'endpoint-a',
        endpoints: [
          {
            id: 'endpoint-a',
            kind: 'websocket',
            label: 'Ubuntu',
            endpoint: 'ws://127.0.0.1:41001',
            deviceToken: 'token-a',
            publicKeyB64: 'host-key-a'
          }
        ]
      }
    ],
    listBrowserProfiles: () => [{ id: 'default', partition: SOURCE }],
    resolveHostStorage: wslHostBrowserRouteStorage,
    bindHostPartition: () => DESTINATION,
    copyCookies: copyBrowserPartitionCookies,
    flushCookies: flushBrowserPartitionCookies
  })
  seedWslMoveCutover(userDataPath, cutover('move-1', 'destination-committed'))
})
afterEach(async () => {
  cancelWslMoveRewriteRetryForTests()
  await vi.runAllTimersAsync()
  cancelWslMoveRewriteRetryForTests()
  resetWslMoveDesktopRewriteStoresForTests()
  resetWslHostsGateForTests()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(userDataPath, { recursive: true, force: true })
})

describe('WSL browser cookie-copy retry ownership', () => {
  it.each([
    { cookieCount: 100, checkpoint: 840000, recovery: 1470000 },
    { cookieCount: 1000, checkpoint: 8400000, recovery: 9030000 }
  ])(
    'joins timed-out copies and recovers the ledger for $cookieCount cookies',
    async ({ cookieCount, checkpoint, recovery }) => {
      electron.jars.set(
        SOURCE,
        Array.from({ length: cookieCount }, (_, index): CdpCookie => ({
          name: `cookie-${index}`,
          value: `value-${index}`,
          domain: '.example.com',
          path: '/',
          secure: true,
          httpOnly: true,
          session: true,
          expires: -1,
          sameSite: 'Lax'
        }))
      )
      const sourceBefore = structuredClone(electron.jars.get(SOURCE))
      const initial = runGatedWslMoveDesktopRewritePass({ userDataPath })
      await advanceTo(30000)
      await initial
      expect(electron.targets.filter((target) => !target.destroyed)).toHaveLength(2)
      expect(listWslMoveCutovers(userDataPath)[0]?.rewrittenStores).toEqual([])
      scheduleWslMoveRewriteRetry(userDataPath)
      await advanceTo(checkpoint)
      const overlap = snapshot()
      expect(overlap.liveTargets).toBe(2)
      expect(overlap.sourceTargets).toBe(1)
      expect(overlap.destinationTargets).toBe(1)
      expect(overlap.sourceReads).toBe(1)
      expect(overlap.ledger).toEqual([])
      expect(electron.targets.every((target) => target.hidden)).toBe(true)

      await advanceTo(cookieCount * electron.commandDelay + 1)
      const drained = snapshot()
      expect(drained.liveTargets).toBe(0)
      expect(drained.destinationCookies).toBe(cookieCount)
      expect(drained.writes).toBe(cookieCount)
      expect(drained.ledger).toEqual([])
      expect(electron.jars.get(SOURCE)).toEqual(sourceBefore)

      await advanceTo(recovery + 1)
      const recovered = snapshot()
      expect(recovered.liveTargets).toBe(0)
      expect(recovered.ledger).toEqual([WSL_MOVE_BROWSER_COOKIES_STORE_ID])
      expect(recovered.phase).toBe('client-rewritten')
      expect(recovered.flushed).toEqual([DESTINATION])
      expect(recovered.writes).toBe(cookieCount)
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('releases a failed run so the next pass can copy successfully', async () => {
    electron.jars.set(SOURCE, [])
    electron.failSourceReads = 1
    await runGatedWslMoveDesktopRewritePass({ userDataPath })
    expect(snapshot().ledger).toEqual([])
    expect(snapshot().liveTargets).toBe(0)

    await runGatedWslMoveDesktopRewritePass({ userDataPath })
    expect(snapshot().phase).toBe('client-rewritten')
    expect(electron.targets.filter((target) => target.partition === SOURCE)).toHaveLength(2)
    expect(snapshot().liveTargets).toBe(0)
  })

  it('keeps the command deadline and retires both targets before recording the store', async () => {
    electron.commandDelay = 10001
    electron.jars.set(SOURCE, [{ name: 'sid', value: 'login', domain: '.example.com', path: '/' }])
    const pass = runGatedWslMoveDesktopRewritePass({ userDataPath })
    await advanceTo(10000)
    await pass
    expect(snapshot().liveTargets).toBe(0)
    expect(snapshot().writes).toBe(0)
    expect(snapshot().ledger).toEqual([WSL_MOVE_BROWSER_COOKIES_STORE_ID])
    expect(listWslMoveCutovers(userDataPath)[0]?.browserCookieCopy).toMatchObject({
      outcome: 'copied',
      profiles: [{ counts: { rejected: 1 } }]
    })
    await advanceTo(10001)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps closed-gate admission and resumes persisted moves in serve-only mode', async () => {
    electron.jars.set(SOURCE, [])
    vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '0')
    await runGatedWslMoveDesktopRewritePass({ userDataPath })
    expect(electron.targets).toEqual([])
    expect(snapshot().ledger).toEqual([])

    configureWslHostsGate({ hasSavedWslHost: () => false, hasWslMoveCutover: () => true })
    await runGatedWslMoveDesktopRewritePass({ userDataPath })
    expect(snapshot().phase).toBe('client-rewritten')
    expect(electron.targets).toHaveLength(2)
    expect(snapshot().liveTargets).toBe(0)
  })

  it('lets a distinct migration finish while another migration copy is still running', async () => {
    electron.jars.set(
      SOURCE,
      Array.from({ length: 8 }, (_, index) => ({
        name: `cookie-${index}`,
        value: 'login',
        domain: '.example.com',
        path: '/'
      }))
    )
    seedWslMoveCutover(
      userDataPath,
      cutover('move-2', 'destination-committed', {}, {}, undefined, 'Debian')
    )
    const pass = runGatedWslMoveDesktopRewritePass({ userDataPath })
    await advanceTo(30000)
    await pass
    expect(
      listWslMoveCutovers(userDataPath).find((entry) => entry.migrationId === 'move-1')
        ?.rewrittenStores
    ).toEqual([])
    expect(
      listWslMoveCutovers(userDataPath).find((entry) => entry.migrationId === 'move-2')?.phase
    ).toBe('client-rewritten')
    expect(snapshot().liveTargets).toBe(2)

    await advanceTo(72001)
    await runGatedWslMoveDesktopRewritePass({ userDataPath })
    expect(
      listWslMoveCutovers(userDataPath).every((entry) => entry.phase === 'client-rewritten')
    ).toBe(true)
    expect(snapshot().liveTargets).toBe(0)
    expect(snapshot().writes).toBe(8)
  })
})
