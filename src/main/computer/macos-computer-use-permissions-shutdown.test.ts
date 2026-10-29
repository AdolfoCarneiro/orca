import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComputerUsePermissionStatusResult } from '../../shared/computer-use-permissions-types'

const mocks = vi.hoisted(() => {
  const quitHandlers: (() => void)[] = []
  return { spawn: vi.fn(), spawnSync: vi.fn(), peek: vi.fn(), readBundleId: vi.fn(), quitHandlers }
})

vi.mock('node:child_process', () => ({ spawn: mocks.spawn, spawnSync: mocks.spawnSync }))
vi.mock('./macos-native-provider-paths', () => ({
  resolveMacOSComputerUseAppPath: () => '/Applications/Orca Computer Use.app'
}))
vi.mock('./macos-computer-use-permission-status', () => ({
  getComputerUsePermissionStatus: vi.fn(),
  resolveComputerUseHelperUnavailableReason: () => null
}))
vi.mock('./macos-computer-use-permission-status-gate', () => ({
  computerUsePermissionStatusGate: { peek: mocks.peek, read: mocks.peek, invalidate: () => {} }
}))
vi.mock('../macos-tcc-reset', () => ({
  readMacosBundleId: mocks.readBundleId,
  resetMacosTccPermission: async () => ({ ok: true })
}))
vi.mock('../../shared/app-environment', () => ({
  hasAppEnvironment: () => true,
  getAppEnvironment: () => ({
    onWillQuit: (handler: () => void) => mocks.quitHandlers.push(handler)
  })
}))

const denied: ComputerUsePermissionStatusResult = {
  platform: 'darwin',
  helperAppPath: '/Applications/Orca Computer Use.app',
  helperUnavailableReason: null,
  permissions: [
    { id: 'accessibility', status: 'not-granted' },
    { id: 'screenshots', status: 'not-granted' }
  ]
}

function setupLaunches(): unknown[] {
  return mocks.spawn.mock.calls
    .filter(([program]) => program === '/usr/bin/open')
    .map(([, args]) => (Array.isArray(args) ? args.slice(3) : []))
}

function deferredStatus(): {
  promise: Promise<ComputerUsePermissionStatusResult>
  resolve: () => void
} {
  let resolve = (): void => {}
  const promise = new Promise<ComputerUsePermissionStatusResult>((settle) => {
    resolve = () => settle(denied)
  })
  return { promise, resolve }
}

describe('computer-use setup cancellation', () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    mocks.spawn.mockReset().mockReturnValue({ unref: () => {} })
    mocks.spawnSync.mockReset()
    mocks.peek.mockReset().mockResolvedValue(denied)
    mocks.readBundleId.mockReset().mockResolvedValue(null)
    mocks.quitHandlers.length = 0
    Object.defineProperty(process, 'platform', { value: 'darwin' })
  })

  afterEach(() => {
    vi.useRealTimers()
    Object.defineProperty(process, 'platform', { value: originalPlatform })
  })

  it('drops a queued launch when any host runs its quit handlers', async () => {
    const { openComputerUsePermissions } = await import('./macos-computer-use-permissions')
    await openComputerUsePermissions('accessibility')
    await openComputerUsePermissions('screenshots')
    for (const quit of mocks.quitHandlers) {
      quit()
    }
    await vi.advanceTimersByTimeAsync(5_000)
    expect(setupLaunches()).toEqual([['--permission', 'accessibility']])
  })

  it('drops an Open still waiting on status when the host quits', async () => {
    const status = deferredStatus()
    mocks.peek.mockReturnValue(status.promise)
    const { openComputerUsePermissions } = await import('./macos-computer-use-permissions')
    const open = openComputerUsePermissions('accessibility')
    for (const quit of mocks.quitHandlers) {
      quit()
    }
    status.resolve()
    await expect(open).resolves.toMatchObject({ launchedHelper: false })
    expect(setupLaunches()).toEqual([])
  })

  it('drops an Open still waiting on status when permissions are reset', async () => {
    const status = deferredStatus()
    mocks.peek.mockReturnValueOnce(status.promise)
    const { openComputerUsePermissions, resetComputerUsePermissions } =
      await import('./macos-computer-use-permissions')
    const open = openComputerUsePermissions('accessibility')
    const reset = resetComputerUsePermissions()
    status.resolve()
    await expect(open).resolves.toMatchObject({ launchedHelper: false })
    await reset
    expect(setupLaunches()).toEqual([])
  })

  it('cancels a queued launch before reset waits on the bundle id', async () => {
    const { openComputerUsePermissions, resetComputerUsePermissions } =
      await import('./macos-computer-use-permissions')
    await openComputerUsePermissions('accessibility')
    await openComputerUsePermissions('screenshots')
    let finishBundleRead = (): void => {}
    mocks.readBundleId.mockReturnValue(
      new Promise<null>((resolve) => {
        finishBundleRead = () => resolve(null)
      })
    )
    const reset = resetComputerUsePermissions()
    await vi.advanceTimersByTimeAsync(6_000)
    finishBundleRead()
    await reset
    expect(setupLaunches()).toEqual([['--permission', 'accessibility']])
  })
})
