import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as BackgroundDistroGate from '../wsl-background-distro-gate'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, args?: unknown) => Promise<unknown>>(),
  runWslProcess: vi.fn(),
  readWslDistroRunningState: vi.fn(),
  listWslDistrosAsync: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args?: unknown) => Promise<unknown>) =>
      mocks.handlers.set(channel, handler)
  }
}))
vi.mock('../wsl/wsl-runner', () => ({ runWslProcess: mocks.runWslProcess }))
vi.mock('../wsl', () => ({ listWslDistrosAsync: mocks.listWslDistrosAsync }))
vi.mock('../wsl-background-distro-gate', async (importOriginal) => ({
  ...(await importOriginal<typeof BackgroundDistroGate>()),
  readWslDistroRunningState: mocks.readWslDistroRunningState
}))
vi.mock('../bitbucket/client', () => ({
  getBitbucketAuthStatus: async () => ({ configured: false, authenticated: false, account: null })
}))
vi.mock('../azure-devops/client', () => ({
  getAzureDevOpsAuthStatus: async () => ({
    configured: false,
    authenticated: false,
    account: null,
    baseUrl: null,
    tokenConfigured: false
  })
}))
vi.mock('../gitea/client', () => ({
  getGiteaAuthStatus: async () => ({
    configured: false,
    authenticated: false,
    account: null,
    baseUrl: null,
    tokenConfigured: false
  })
}))

import { registerPreflightHandlers } from './preflight'
import { _resetPreflightCache } from '../preflight/agent-detection'
import { getDefaultSettings } from '../../shared/constants'

const UBUNTU = { wslDistro: 'Ubuntu' }

function invoke(channel: string, args?: unknown): Promise<unknown> {
  const handler = mocks.handlers.get(channel)
  if (!handler) {
    throw new Error(`no handler for ${channel}`)
  }
  return handler(null, args)
}

describe('preflight never starts a stopped WSL distro in the background (E9)', () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    mocks.handlers.clear()
    _resetPreflightCache()
    mocks.readWslDistroRunningState.mockReset().mockResolvedValue('stopped')
    mocks.listWslDistrosAsync.mockReset().mockResolvedValue(['Ubuntu', 'Debian'])
    mocks.runWslProcess.mockReset().mockResolvedValue({
      environmentResolved: true,
      code: 0,
      stdout: '',
      stderr: '',
      timedOut: false
    })
    registerPreflightHandlers({ getSettings: () => getDefaultSettings('/tmp') })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
  })

  it('refuses a mount or poll check of a stopped distro without spawning wsl.exe', async () => {
    await expect(invoke('preflight:check', { ...UBUNTU, force: true })).rejects.toMatchObject({
      code: 'WSL_DISTRO_STOPPED',
      distro: 'Ubuntu'
    })
    expect(mocks.runWslProcess).not.toHaveBeenCalled()
  })

  it('refuses when WSL cannot say whether the distro runs', async () => {
    mocks.readWslDistroRunningState.mockResolvedValue('unverifiable')
    await expect(invoke('preflight:check', UBUNTU)).rejects.toMatchObject({
      code: 'WSL_DISTRO_UNVERIFIABLE'
    })
    expect(mocks.runWslProcess).not.toHaveBeenCalled()
  })

  it('checks the default distro when the workspace names none', async () => {
    await expect(invoke('preflight:check', { wslDefault: true })).rejects.toMatchObject({
      distro: 'Ubuntu'
    })
    expect(mocks.runWslProcess).not.toHaveBeenCalled()
  })

  it('lets a window-focus or retry wake start the focused workspace distro', async () => {
    await invoke('preflight:check', { ...UBUNTU, force: true, wakeWslDistro: true })
    expect(mocks.runWslProcess).toHaveBeenCalled()
    for (const [spec] of mocks.runWslProcess.mock.calls) {
      expect(spec).toMatchObject({ distro: 'Ubuntu' })
    }
  })

  it('probes a running distro exactly as before', async () => {
    mocks.readWslDistroRunningState.mockResolvedValue('running')
    await invoke('preflight:check', UBUNTU)
    expect(mocks.runWslProcess).toHaveBeenCalled()
  })

  it('refuses mount-time agent detection in a stopped distro', async () => {
    await expect(
      invoke('preflight:detectAgents', { ...UBUNTU, enabledOnly: true })
    ).rejects.toMatchObject({ code: 'WSL_DISTRO_STOPPED' })
    expect(mocks.runWslProcess).not.toHaveBeenCalled()
  })

  it('refuses a background agent refresh but lets a refresh click start the distro', async () => {
    await expect(invoke('preflight:refreshAgents', UBUNTU)).rejects.toMatchObject({
      code: 'WSL_DISTRO_STOPPED'
    })
    expect(mocks.runWslProcess).not.toHaveBeenCalled()

    await invoke('preflight:refreshAgents', { ...UBUNTU, wakeWslDistro: true })
    expect(mocks.runWslProcess).toHaveBeenCalled()
  })
})
