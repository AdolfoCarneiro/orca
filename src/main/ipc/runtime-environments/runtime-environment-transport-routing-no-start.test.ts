import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  resolveManaged: vi.fn(),
  statusProbe: vi.fn(async () => ({ id: 'status.get', ok: true, result: {}, _meta: {} }))
}))

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('../../../shared/runtime-environment-store', () => ({
  resolveEnvironment: (_userDataPath: string, id: string) => ({ id, createdAt: 1 }),
  markEnvironmentUsed: vi.fn()
}))
vi.mock('./runtime-environment-managed-tunnel', () => ({
  resolveManagedRuntimeEnvironment: mocks.resolveManaged
}))
vi.mock('./runtime-environment-status-probe', () => ({
  getRuntimeEnvironmentStatus: mocks.statusProbe
}))

import { callRuntimeEnvironment } from './runtime-environment-transport-routing'

const NO_START = { preparation: { wslStart: 'never' as const } }

describe("a no-start caller's status probe", () => {
  beforeEach(() => {
    mocks.resolveManaged.mockReset()
    mocks.statusProbe.mockClear()
  })

  it('refuses a stopped WSL host before the probe can dial it', async () => {
    mocks.resolveManaged.mockRejectedValue(new Error('The WSL host Ubuntu isn’t running.'))
    await expect(
      callRuntimeEnvironment(
        '/u',
        'wsl:ubuntu',
        'status.get',
        {},
        1_000,
        undefined,
        undefined,
        NO_START
      )
    ).rejects.toThrow('isn’t running')
    expect(mocks.resolveManaged).toHaveBeenCalledWith('/u', 'wsl:ubuntu', NO_START.preparation)
    expect(mocks.statusProbe).not.toHaveBeenCalled()
  })

  it('probes a running host, and leaves the desktop’s own probe unchecked', async () => {
    mocks.resolveManaged.mockResolvedValue({ id: 'wsl:ubuntu', createdAt: 1 })
    await callRuntimeEnvironment(
      '/u',
      'wsl:ubuntu',
      'status.get',
      {},
      1_000,
      undefined,
      undefined,
      NO_START
    )
    expect(mocks.statusProbe).toHaveBeenCalledTimes(1)

    await callRuntimeEnvironment('/u', 'wsl:ubuntu', 'status.get', {}, 1_000)
    expect(mocks.resolveManaged).toHaveBeenCalledTimes(1)
    expect(mocks.statusProbe).toHaveBeenCalledTimes(2)
  })
})
