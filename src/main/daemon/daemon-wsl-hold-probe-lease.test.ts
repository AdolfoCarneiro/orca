import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as WslModule from '../wsl'
import { _resetWslBackgroundDistroGateForTests } from '../wsl-background-distro-gate'
import {
  _resetRunningWslDistroCacheForTests,
  resolveRunningWslDistros
} from '../wsl-running-distro-cache'
import { parseWslDistroHold } from '../../shared/wsl-distro-stopped-hold'
import {
  holdPassiveRestoreOfStoppedWslDistro,
  WSL_PROVIDER_HOLD_LEASE_MS
} from './daemon-wsl-passive-restore-hold'

const running = vi.hoisted(() => {
  const value: { distros: string[] } = { distros: ['Ubuntu'] }
  return value
})
const probe = vi.hoisted(() => vi.fn(async () => [...running.distros]))
vi.mock('../wsl', async (importOriginal) => ({
  ...(await importOriginal<typeof WslModule>()),
  listRunningWslDistrosAsync: (options: Parameters<typeof resolveRunningWslDistros>[1]) =>
    resolveRunningWslDistros(probe, options)
}))

const HELD = { wslBackgroundStart: true as const, isNewSession: true }
// The startup-target hold reads fresh; the provider hold right after it uses the short lease.
const startupTargetHold = () => holdPassiveRestoreOfStoppedWslDistro(HELD, 'Ubuntu')
const providerHold = () =>
  holdPassiveRestoreOfStoppedWslDistro(HELD, 'Ubuntu', { leaseMs: WSL_PROVIDER_HOLD_LEASE_MS })
const heldState = (error: unknown) =>
  error instanceof Error ? parseWslDistroHold(error.message)?.state : undefined

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['performance', 'Date'] })
  running.distros = ['Ubuntu']
  probe.mockClear()
})

afterEach(() => {
  _resetWslBackgroundDistroGateForTests()
  _resetRunningWslDistroCacheForTests()
  vi.useRealTimers()
})

describe('a held-path WSL spawn reads the running list once (E9)', () => {
  it('runs one probe across the startup-target and provider holds', async () => {
    await startupTargetHold()
    await providerHold()
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('holds a stopped distro at both, still with one probe', async () => {
    running.distros = []
    expect(heldState(await startupTargetHold().catch((error: unknown) => error))).toBe('stopped')
    expect(heldState(await providerHold().catch((error: unknown) => error))).toBe('stopped')
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('probes again once the read is older than the lease, so a stale stop is not reused', async () => {
    running.distros = []
    await startupTargetHold().catch(() => {})
    running.distros = ['Ubuntu']
    vi.advanceTimersByTime(WSL_PROVIDER_HOLD_LEASE_MS + 1)

    await providerHold()
    expect(probe).toHaveBeenCalledTimes(2)
  })
})
