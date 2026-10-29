import type { subscribeRemoteRuntimeRequest } from '../../../shared/remote-runtime/remote-runtime-client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcadDeploymentLink } from '../../../shared/runtime-environments'

type Environment = { id: string; createdAt: number; orcadDeployment?: OrcadDeploymentLink }

const mocks = vi.hoisted(() => ({
  environments: new Map<string, Environment>(),
  resolveManaged: vi.fn(),
  subscribe: vi.fn(),
  wslCheck: vi.fn(async () => {}),
  statusProbe: vi.fn(async () => ({ id: 'status.get', ok: true, result: {}, _meta: {} }))
}))

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('../../../shared/runtime-environment-store', () => ({
  resolveEnvironment: (_userDataPath: string, id: string) =>
    mocks.environments.get(id) ?? { id, createdAt: 1 },
  markEnvironmentUsed: vi.fn()
}))
vi.mock('./runtime-environment-managed-tunnel', async () => {
  const { classifyRuntimeEnvironmentHost } =
    await import('../../../shared/runtime-environment-host-kind')
  return {
    resolveManagedRuntimeEnvironment: mocks.resolveManaged,
    // The real helper's dispatch, with the WSL check stubbed.
    requireWslHostWithoutStart: async (_userDataPath: string, selector: string) => {
      const environment = mocks.environments.get(selector) ?? { id: selector, createdAt: 1 }
      if (classifyRuntimeEnvironmentHost(environment).kind === 'wsl') {
        await mocks.wslCheck()
      }
    }
  }
})
vi.mock('./runtime-environment-status-probe', () => ({
  getRuntimeEnvironmentStatus: mocks.statusProbe
}))

vi.mock('../../../shared/remote-runtime/remote-runtime-client', async (importOriginal) => ({
  ...(await importOriginal()),
  subscribeRemoteRuntimeRequest: mocks.subscribe
}))
vi.mock('./runtime-environment-usage-record', () => ({ recordRuntimeEnvironmentUsage: vi.fn() }))
import {
  createEnvironmentFromPairingOffer,
  getPreferredPairedRuntimeConnection
} from '../../../shared/runtime-environments'
import {
  callRuntimeEnvironment,
  subscribeRuntimeEnvironment
} from './runtime-environment-transport-routing'

const NO_START = { preparation: { wslStart: 'never' as const } }

function statusGet(
  id: string,
  options?: typeof NO_START & { expectedEnvironmentRuntimeId?: string }
) {
  return callRuntimeEnvironment('/u', id, 'status.get', {}, 1_000, undefined, undefined, options)
}

describe("a no-start caller's status probe", () => {
  beforeEach(() => {
    mocks.environments.clear()
    mocks.environments.set('wsl:ubuntu', {
      id: 'wsl:ubuntu',
      createdAt: 1,
      orcadDeployment: { kind: 'wsl', distro: 'Ubuntu', localPort: 1, remotePort: 2 }
    })
    mocks.environments.set('ssh-managed', {
      id: 'ssh-managed',
      createdAt: 1,
      orcadDeployment: { sshTargetId: 't', sshTargetGeneration: 1, localPort: 1, remotePort: 2 }
    })
    mocks.resolveManaged.mockReset()
    mocks.wslCheck.mockReset()
    mocks.statusProbe.mockClear()
  })

  it('refuses a stopped WSL host before the probe can dial it', async () => {
    mocks.wslCheck.mockRejectedValue(new Error('The WSL host Ubuntu isn’t running.'))
    await expect(statusGet('wsl:ubuntu', NO_START)).rejects.toThrow('isn’t running')
    expect(mocks.statusProbe).not.toHaveBeenCalled()
  })

  it('probes a running WSL host with the options it would have had without the check', async () => {
    await statusGet('wsl:ubuntu', { ...NO_START, expectedEnvironmentRuntimeId: 'r' })
    expect(mocks.wslCheck).toHaveBeenCalledTimes(1)
    expect(mocks.statusProbe).toHaveBeenCalledWith(
      '/u',
      'wsl:ubuntu',
      1_000,
      { expectedEnvironmentRuntimeId: 'r' },
      true
    )
  })

  it('leaves an SSH-managed or plain paired server’s probe exactly as before', async () => {
    for (const id of ['ssh-managed', 'paired']) {
      await statusGet(id, NO_START)
      await statusGet(id)
    }
    // No reconnect, deploy or managed resolve: the status owner alone handles these.
    expect(mocks.resolveManaged).not.toHaveBeenCalled()
    expect(mocks.wslCheck).not.toHaveBeenCalled()
    expect(mocks.statusProbe).toHaveBeenCalledTimes(4)
    expect(mocks.statusProbe).toHaveBeenNthCalledWith(1, '/u', 'ssh-managed', 1_000, {}, true)
    expect(mocks.statusProbe).toHaveBeenNthCalledWith(
      2,
      '/u',
      'ssh-managed',
      1_000,
      undefined,
      true
    )
  })
})

it('captures the selected prepared route before a synchronous authenticated first completion frame', async () => {
  const selected = createEnvironmentFromPairingOffer({
    id: 'prepared',
    name: 'Prepared',
    now: 2,
    runtimeId: null,
    offer: {
      v: 2,
      endpoint: 'ws://127.0.0.1:41000/runtime',
      publicKeyB64: Buffer.alloc(32, 2).toString('base64'),
      deviceToken: 'prepared-token'
    }
  })
  const preparation = Promise.withResolvers<typeof selected>()
  mocks.resolveManaged.mockReturnValueOnce(preparation.promise)
  const onSource = vi.fn()
  const onEvent = vi.fn()
  mocks.subscribe.mockImplementationOnce(
    (...parameters: Parameters<typeof subscribeRemoteRuntimeRequest>) => {
      expect(onSource).toHaveBeenCalledExactlyOnceWith(
        selected,
        getPreferredPairedRuntimeConnection(selected)
      )
      parameters[4].onResponse({
        id: 'first',
        ok: true,
        result: {},
        _meta: { runtimeId: 'prepared-runtime' }
      })
      return Promise.resolve({ requestId: 'first', close: () => {}, sendBinary: () => true })
    }
  )
  const opening = subscribeRuntimeEnvironment(
    '/profile',
    'original-selector',
    'agentSession.subscribeTurnCompletions',
    {},
    1000,
    { onSource, onEvent, onClose: () => {} }
  )
  expect(onSource).not.toHaveBeenCalled()
  preparation.resolve(selected)
  await opening
  expect(onEvent).toHaveBeenCalledWith(
    expect.objectContaining({
      type: 'response',
      response: expect.objectContaining({ id: 'first' })
    })
  )
})
