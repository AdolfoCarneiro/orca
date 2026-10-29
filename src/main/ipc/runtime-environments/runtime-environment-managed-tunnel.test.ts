import type * as RuntimeEnvironmentStore from '../../../shared/runtime-environment-store'
import { subscribeRuntimeEnvironment } from './runtime-environment-transport-routing'
import { EventEmitter } from 'node:events'
import {
  registerRuntimeEnvironmentSubscriptionHandlers,
  type PendingRuntimeSubscription,
  type RetainedRemoteRuntimeSubscription
} from './runtime-environment-subscription-handlers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEnvironmentFromPairingOffer } from '../../../shared/runtime-environments'
import { PAIRING_OFFER_VERSION } from '../../../shared/pairing'
import { PromiseSettlementWaiters } from '../../../shared/promise-settlement-waiters'
import type * as ServingModule from '../../managed-server/lifecycle/orcad-managed-serving'
import type { ManagedOrcadStartListener } from '../../managed-server/lifecycle/orcad-managed-serving'
import type { SshTarget } from '../../../shared/ssh-types'

const mocks = vi.hoisted(() => {
  const startListener: { current: ManagedOrcadStartListener | null } = { current: null }
  const environments: Record<string, Record<string, unknown>> = {}
  const reads: Record<string, number> = {}
  return {
    environments,
    reads,
    ensureForRuntimeCall: vi.fn(async () => {}),
    requireRunningWithoutStart: vi.fn(async () => {}),
    hasWslService: true,
    rawSubscribe: vi.fn(),
    handle: vi.fn(),
    on: vi.fn(),
    ensureTunnel: vi.fn(async () => {}),
    rebuildTunnel: vi.fn(async () => {}),
    verify: vi.fn(),
    restoreUpdate: vi.fn(() => null),
    redeploy: vi.fn(async () => true),
    forgetVerdict: vi.fn(),
    restoreForwards: vi.fn(async () => {}),
    startListener
  }
})

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: mocks.handle, on: mocks.on }
}))
vi.mock('../../../shared/remote-runtime/remote-runtime-client', () => ({
  subscribeRemoteRuntimeRequest: mocks.rawSubscribe
}))
vi.mock('../../../shared/runtime-environment-store', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeEnvironmentStore>()),
  resolveEnvironment: (_userData: string, id: string) => {
    const environment = mocks.environments[id]
    if (!environment) {
      return { id, orcadDeployment: { sshTargetId: 'ssh-1' } }
    }
    mocks.reads[id] = (mocks.reads[id] ?? 0) + 1
    // Fresh records distinguish the post-bring-up read from the initial lookup.
    return { ...environment, read: mocks.reads[id] }
  }
}))
vi.mock('../../wsl/wsl-host-service-instance', () => ({
  getWslHostService: () =>
    mocks.hasWslService ? { ensureForRuntimeCall: mocks.ensureForRuntimeCall } : null,
  getWslHostPhoneGate: () =>
    mocks.hasWslService ? { requireRunningWithoutStart: mocks.requireRunningWithoutStart } : null
}))
vi.mock('../../ssh/managed-server-update-deps', () => ({ managedServerUpdateDeps: () => ({}) }))
vi.mock('../../managed-server/lifecycle/orcad-managed-tunnel', () => ({
  ensureOrcadManagedTunnel: mocks.ensureTunnel,
  rebuildOrcadManagedTunnel: mocks.rebuildTunnel
}))
vi.mock('../../managed-server/lifecycle/orcad-managed-serving-verify', () => ({
  verifyOrcadManagedServing: mocks.verify
}))
vi.mock('../../managed-server/lifecycle/orcad-managed-update-on-restore', () => ({
  updateManagedOrcadOnRestore: mocks.restoreUpdate,
  redeployStoppedManagedOrcad: mocks.redeploy
}))
vi.mock('../../ssh/ssh-host-server-status', () => ({ setSshHostServerStatus: vi.fn() }))
vi.mock('../../ssh/targets/ssh-target-registry', () => ({ getSshTargetRegistryStore: () => null }))
vi.mock('../ssh/ssh-ipc-context', () => ({
  connectionManager: null,
  getCurrentMainWindow: () => null
}))
vi.mock('../ssh/ssh-renderer-broadcast', () => ({ broadcastSshState: vi.fn() }))
vi.mock('../ssh/ssh-managed-port-forward-restore', () => ({
  restoreManagedHostPortForwards: mocks.restoreForwards
}))
vi.mock('../ssh/ssh-host-launch-session-note', () => ({
  forgetLaunchSessionVerdict: mocks.forgetVerdict
}))
vi.mock('../../managed-server/lifecycle/orcad-managed-serving', async (importOriginal) => ({
  ...(await importOriginal<typeof ServingModule>()),
  setManagedOrcadStartListener: (listener: ManagedOrcadStartListener | null) => {
    mocks.startListener.current = listener
  }
}))

import { MANAGED_ORCAD_NOT_ACTIVATED_DETAIL } from '../../managed-server/lifecycle/orcad-managed-serving'
import {
  installManagedOrcadStartStatus,
  requireWslHostWithoutStart,
  resolveManagedRuntimeEnvironment
} from './runtime-environment-managed-tunnel'
import { WSL_HOSTS_GATED_OFF_MESSAGE } from '../../wsl/wsl-host-gate'
import { WSL_HOSTS_INTERNAL_GATE_ENV } from '../../../shared/wsl-host-internal-gate'

describe('resolving a managed runtime for a call', () => {
  beforeEach(() => vi.clearAllMocks())

  it('redeploys, before the call, a server another desktop stopped mid-session', async () => {
    mocks.verify.mockResolvedValue({
      state: 'unverifiable',
      detail: MANAGED_ORCAD_NOT_ACTIVATED_DETAIL
    })
    await resolveManagedRuntimeEnvironment('/u', 'env-1')
    expect(mocks.redeploy).toHaveBeenCalledWith('env-1', expect.any(Function))
    expect(mocks.restoreUpdate).not.toHaveBeenCalled()
    expect(mocks.ensureTunnel).toHaveBeenCalledTimes(1)
    expect(mocks.rebuildTunnel).toHaveBeenCalledWith('/u', 'env-1')
  })

  it('forgets a cached ended launch session once this client redeployed the server', async () => {
    mocks.verify.mockResolvedValue({
      state: 'unverifiable',
      detail: MANAGED_ORCAD_NOT_ACTIVATED_DETAIL
    })
    await resolveManagedRuntimeEnvironment('/u', 'env-1')
    expect(mocks.forgetVerdict).toHaveBeenCalledWith('ssh-1')
    expect(mocks.forgetVerdict.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.rebuildTunnel.mock.invocationCallOrder[0]
    )
  })

  it('keeps the verdict when the redeploy did not start a server', async () => {
    mocks.verify.mockResolvedValue({
      state: 'unverifiable',
      detail: MANAGED_ORCAD_NOT_ACTIVATED_DETAIL
    })
    mocks.redeploy.mockResolvedValueOnce(false)
    await resolveManagedRuntimeEnvironment('/u', 'env-1')
    expect(mocks.forgetVerdict).not.toHaveBeenCalled()
  })

  // #32484: an update check that never settles, or a failed redeploy, publishes no served status.
  it.each([
    ['a serving server', { state: 'serving' }, true],
    [
      'a server whose redeploy failed',
      { state: 'unverifiable', detail: MANAGED_ORCAD_NOT_ACTIVATED_DETAIL },
      false
    ]
  ] as const)(
    'restores saved forwards once the tunnel is up, for %s',
    async (_name, serving, redeployed) => {
      mocks.verify.mockResolvedValue(serving)
      mocks.redeploy.mockResolvedValueOnce(redeployed)
      await resolveManagedRuntimeEnvironment('/u', 'env-1')
      expect(mocks.restoreForwards).toHaveBeenCalledWith('ssh-1', { tunnelUp: true })
      expect(mocks.ensureTunnel.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.restoreForwards.mock.invocationCallOrder[0]
      )
    }
  )

  it('leaves a serving server to the once-per-session update check', async () => {
    mocks.verify.mockResolvedValue({ state: 'serving' })
    await resolveManagedRuntimeEnvironment('/u', 'env-1')
    expect(mocks.redeploy).not.toHaveBeenCalled()
    expect(mocks.restoreUpdate).toHaveBeenCalledWith('env-1', expect.any(Function))
  })
})

describe('resolving a runtime for a call, by host kind', () => {
  const wsl = {
    id: 'wsl:ubuntu',
    orcadDeployment: { kind: 'wsl', distro: 'Ubuntu', localPort: 42000, remotePort: 6768 }
  }
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.hasWslService = true
    for (const id of Object.keys(mocks.reads)) {
      delete mocks.reads[id]
    }
    mocks.environments = { 'wsl:ubuntu': wsl, 'paired-1': { id: 'paired-1' } }
    mocks.verify.mockResolvedValue({ state: 'serving' })
    vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
  })
  afterEach(() => vi.unstubAllEnvs())

  it('brings a WSL host up through its service, never through an SSH tunnel', async () => {
    // Bring-up may change the WSL bridge port.
    await expect(resolveManagedRuntimeEnvironment('/u', 'wsl:ubuntu')).resolves.toEqual({
      ...wsl,
      read: 2
    })
    expect(mocks.ensureForRuntimeCall).toHaveBeenCalledWith('wsl:ubuntu')
    expect(mocks.ensureTunnel).not.toHaveBeenCalled()
    expect(mocks.verify).not.toHaveBeenCalled()
    expect(mocks.restoreUpdate).not.toHaveBeenCalled()
  })

  it('resolves a WSL host with no service without bringing anything up', async () => {
    mocks.hasWslService = false
    await expect(resolveManagedRuntimeEnvironment('/u', 'wsl:ubuntu')).resolves.toEqual({
      ...wsl,
      read: 2
    })
    expect(mocks.ensureTunnel).not.toHaveBeenCalled()
  })

  it("serves a phone's call only from a WSL host already running, never starting it", async () => {
    const noStart = { wslStart: 'never' } as const
    await expect(resolveManagedRuntimeEnvironment('/u', 'wsl:ubuntu', noStart)).resolves.toEqual({
      ...wsl,
      read: 2
    })
    expect(mocks.requireRunningWithoutStart).toHaveBeenCalledWith('wsl:ubuntu')
    expect(mocks.ensureForRuntimeCall).not.toHaveBeenCalled()

    mocks.requireRunningWithoutStart.mockRejectedValueOnce(new Error('stopped'))
    await expect(resolveManagedRuntimeEnvironment('/u', 'wsl:ubuntu', noStart)).rejects.toThrow(
      'stopped'
    )
    mocks.hasWslService = false
    await expect(resolveManagedRuntimeEnvironment('/u', 'wsl:ubuntu', noStart)).rejects.toThrow(
      'The WSL host Ubuntu isn’t available from your phone right now. Open one of its projects on your computer to connect it.'
    )
    expect(mocks.ensureForRuntimeCall).not.toHaveBeenCalled()
  })

  it("checks only a WSL host for a phone's status probe, leaving any other server untouched", async () => {
    const noStart = { wslStart: 'never' } as const
    // An unknown id resolves to an SSH-managed server; paired-1 has no deployment.
    for (const id of ['ssh-managed', 'paired-1']) {
      await requireWslHostWithoutStart('/u', id, noStart)
    }
    expect(mocks.ensureTunnel).not.toHaveBeenCalled()
    expect(mocks.rebuildTunnel).not.toHaveBeenCalled()
    expect(mocks.verify).not.toHaveBeenCalled()
    expect(mocks.requireRunningWithoutStart).not.toHaveBeenCalled()

    await requireWslHostWithoutStart('/u', 'wsl:ubuntu', noStart)
    expect(mocks.requireRunningWithoutStart).toHaveBeenCalledWith('wsl:ubuntu')
    expect(mocks.ensureForRuntimeCall).not.toHaveBeenCalled()
  })

  it('refuses a WSL host with the gate closed', async () => {
    vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '')
    await expect(resolveManagedRuntimeEnvironment('/u', 'wsl:ubuntu')).rejects.toThrow(
      WSL_HOSTS_GATED_OFF_MESSAGE
    )
    expect(mocks.ensureForRuntimeCall).not.toHaveBeenCalled()
  })

  it('runs the managed tunnel path for a paired server too', async () => {
    await expect(resolveManagedRuntimeEnvironment('/u', 'paired-1')).resolves.toEqual({
      id: 'paired-1',
      read: 2
    })
    expect(mocks.ensureTunnel).toHaveBeenCalledWith('/u', 'paired-1')
    expect(mocks.verify).toHaveBeenCalledWith('/u', 'paired-1')
    expect(mocks.restoreUpdate).toHaveBeenCalledWith('paired-1', expect.any(Function))
    expect(mocks.ensureForRuntimeCall).not.toHaveBeenCalled()
  })
})

describe('a managed server start shown on the status line', () => {
  const target: SshTarget = { id: 'ssh-1', label: 'mac', host: 'mac', port: 22, username: 'u' }

  beforeEach(() => {
    vi.clearAllMocks()
    installManagedOrcadStartStatus()
  })

  it('forgets a cached ended launch session once this client started the server', async () => {
    mocks.startListener.current?.settled(target, 'env-1', { state: 'started', boundPort: 1 })
    await vi.waitFor(() => expect(mocks.forgetVerdict).toHaveBeenCalledWith('ssh-1'))
  })

  it('keeps the verdict when no start happened', async () => {
    mocks.startListener.current?.settled(target, 'env-1', { state: 'unverifiable', detail: 'x' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(mocks.forgetVerdict).not.toHaveBeenCalled()
  })
})

describe('crew waits at the actual managed preparation/routing boundary', () => {
  beforeEach(() => {
    mocks.ensureTunnel.mockReset().mockResolvedValue(undefined)
    mocks.rawSubscribe.mockReset()
    mocks.verify.mockResolvedValue({ state: 'serving' })
    mocks.restoreUpdate.mockReset().mockResolvedValue(undefined)
  })

  it('preserves the actual readonly AbortError on the ordinary subscription hint path', async () => {
    mocks.environments = {
      plain: createEnvironmentFromPairingOffer({
        id: 'plain',
        name: 'Paired',
        now: 1,
        offer: {
          v: PAIRING_OFFER_VERSION,
          endpoint: 'ws://127.0.0.1:42000',
          deviceToken: 'fixture',
          publicKeyB64: 'fixture'
        }
      })
    }
    const abort = new DOMException('The operation was aborted.', 'AbortError')
    mocks.rawSubscribe.mockRejectedValueOnce(abort)
    await expect(
      subscribeRuntimeEnvironment('/u', 'plain', 'orchestration.crewSubscribe', {}, undefined, {
        onEvent: vi.fn(),
        onClose: vi.fn()
      })
    ).rejects.toBe(abort)
    expect(abort.name).toBe('AbortError')
    expect(abort.message).toBe('The operation was aborted.')
    const remote = new Map<string, RetainedRemoteRuntimeSubscription>()
    const pending = new Map<string, PendingRuntimeSubscription>()
    mocks.handle.mockClear()
    registerRuntimeEnvironmentSubscriptionHandlers({
      getUserDataPath: () => '/u',
      remoteRuntimeSubscriptions: remote,
      pendingSubscriptions: pending,
      recordLayoutFrame: vi.fn()
    })
    const sender = Object.assign(new EventEmitter(), {
      id: 101,
      mainFrame: { detached: false },
      isDestroyed: () => false,
      send: vi.fn()
    })
    const subscribe = mocks.handle.mock.calls.find(
      ([channel]) => channel === 'runtimeEnvironments:subscribe'
    )![1]
    mocks.rawSubscribe.mockRejectedValueOnce(abort)
    await expect(
      subscribe(
        { sender, senderFrame: sender.mainFrame },
        {
          selector: 'plain',
          method: 'orchestration.crewSubscribe',
          subscriptionId: 'lower-abort',
          setupResult: 'crew',
          expectedEnvironmentPairingRevision: 1,
          expectedEnvironmentRuntimeId: null
        }
      )
    ).resolves.toEqual({
      subscriptionId: 'lower-abort',
      ok: false,
      failure: { message: abort.message, fact: { kind: 'operation', operation: 'subscription' } }
    })
    expect(pending.size).toBe(0)
    expect(remote.size).toBe(0)
    expect(sender.eventNames()).toEqual([])
  })

  it.each(['resolve', 'reject'] as const)(
    'retires N/10N removable waits before shared preparation can %s',
    async (settlement) => {
      const waits: InstanceType<typeof PromiseSettlementWaiters>[] = []
      const wait = PromiseSettlementWaiters.prototype.wait
      const waitSpy = vi
        .spyOn(PromiseSettlementWaiters.prototype, 'wait')
        .mockImplementation(function (this: PromiseSettlementWaiters<unknown>, options) {
          waits.push(this)
          return wait.call(this, options)
        })
      try {
        for (const count of [1, 10]) {
          waits.length = 0
          mocks.rawSubscribe.mockReset()
          mocks.ensureTunnel.mockReset()
          const held = Promise.withResolvers<void>()
          mocks.ensureTunnel.mockReturnValue(held.promise)
          mocks.environments = {
            crew: {
              ...createEnvironmentFromPairingOffer({
                id: 'crew',
                name: 'Builder',
                now: 1,
                connectionDependency: 'ssh-tunnel',
                offer: {
                  v: PAIRING_OFFER_VERSION,
                  endpoint: 'ws://127.0.0.1:42000',
                  deviceToken: 'fixture',
                  publicKeyB64: 'fixture'
                }
              }),
              orcadDeployment: {
                sshTargetId: 'ssh-1',
                sshTargetGeneration: 1,
                localPort: 42000,
                remotePort: 6768
              }
            }
          }
          const remote = new Map<string, RetainedRemoteRuntimeSubscription>()
          const pendingOwners = new Map<string, PendingRuntimeSubscription>()
          mocks.handle.mockClear()
          registerRuntimeEnvironmentSubscriptionHandlers({
            getUserDataPath: () => '/u',
            remoteRuntimeSubscriptions: remote,
            pendingSubscriptions: pendingOwners,
            recordLayoutFrame: vi.fn()
          })
          const sender = Object.assign(new EventEmitter(), {
            id: 100,
            mainFrame: { detached: false },
            isDestroyed: () => false,
            send: vi.fn()
          })
          const subscribe = mocks.handle.mock.calls.find(
            ([channel]) => channel === 'runtimeEnvironments:subscribe'
          )![1]
          const cancel = mocks.handle.mock.calls.find(
            ([channel]) => channel === 'runtimeEnvironments:unsubscribe'
          )![1]
          const pending = Array.from({ length: count }, (_, index) =>
            subscribe(
              { sender, senderFrame: sender.mainFrame },
              {
                selector: 'crew',
                method: 'orchestration.crewSubscribe',
                subscriptionId: `crew-${index}`,
                setupResult: 'crew',
                expectedEnvironmentPairingRevision: 1,
                expectedEnvironmentRuntimeId: null
              }
            )
          )
          expect(mocks.ensureTunnel).toHaveBeenCalledTimes(count)
          expect(pendingOwners.size).toBe(count)
          expect(remote.size).toBe(0)
          expect(waits).toHaveLength(count)
          expect(waits.reduce((total, owner) => total + owner.waiterCount, 0)).toBe(count)
          expect(sender.listenerCount('did-navigate')).toBe(1)
          for (let index = 0; index < count; index++) {
            expect(cancel({ sender }, { subscriptionId: `crew-${index}` })).toEqual({
              unsubscribed: true
            })
          }
          const outcomes = await Promise.all(pending)
          expect(outcomes).toEqual(
            Array.from({ length: count }, (_, index) => ({
              subscriptionId: `crew-${index}`,
              ok: false,
              failure: { message: expect.any(String), fact: { kind: 'cancelled' } }
            }))
          )
          expect(pendingOwners.size).toBe(0)
          expect(remote.size).toBe(0)
          expect(sender.eventNames()).toEqual([])
          expect(waits.reduce((total, owner) => total + owner.waiterCount, 0)).toBe(0)
          expect(mocks.rawSubscribe).not.toHaveBeenCalled()
          // The N async preparation wrappers are still held; cancellation does not cancel that work.
          if (settlement === 'resolve') {
            held.resolve()
          } else {
            held.reject(new Error('late shared failure'))
          }
          await Promise.all(waits.map((owner) => owner.promise.catch(() => undefined)))
          expect(mocks.rawSubscribe).not.toHaveBeenCalled()
          expect(sender.send).not.toHaveBeenCalled()
          expect(mocks.ensureTunnel).toHaveBeenCalledTimes(count)
        }
      } finally {
        waitSpy.mockRestore()
        mocks.ensureTunnel.mockReset().mockResolvedValue(undefined)
      }
    }
  )
})
