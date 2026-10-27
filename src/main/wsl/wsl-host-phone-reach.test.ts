import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WslHostConnectionState } from '../../shared/wsl-host-types'
import type { WslHostReachability } from './wsl-host-connector-contract'
import { WslHostPhoneGate } from './wsl-host-phone-reach'
import type { WslOrcadConnection } from './wsl-orcad-connection-types'

const BRIDGE: WslOrcadConnection = {
  distro: 'Ubuntu',
  environmentId: 'wsl:ubuntu',
  localPort: 1,
  remotePort: 1,
  fullVersion: 'test',
  pid: null,
  pairingOffer: '',
  deferredUpdate: null,
  close: async () => {}
}

const STOPPED =
  'The WSL host Ubuntu isn’t running. Open one of its projects on your computer to start it.'
const NEUTRAL =
  'The WSL host Ubuntu isn’t available from your phone right now. Open one of its projects on your computer to connect it.'

function makeGate() {
  const state: {
    enabled: boolean
    status: WslHostConnectionState
    bridged: boolean
    pendingStop: boolean
    reachability: WslHostReachability
  } = {
    enabled: true,
    status: 'ready',
    bridged: true,
    pendingStop: false,
    reachability: 'available'
  }
  const listeners = new Set<() => void>()
  const reachability = vi.fn(async () => state.reachability)
  const gate = new WslHostPhoneGate({
    service: {
      getStatuses: () => [{ environmentId: 'wsl:ubuntu', state: state.status }],
      onStatusesChanged: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      recordForEnvironment: (environmentId) =>
        environmentId === 'wsl:ubuntu'
          ? {
              environmentId,
              distro: 'Ubuntu',
              ...(state.pendingStop
                ? { pendingStop: { since: 1, reason: 'remove', verdict: 'live' as const } }
                : {})
            }
          : null
    },
    connector: { get: () => (state.bridged ? BRIDGE : null), reachability },
    isEnabled: () => state.enabled,
    hasServerFiles: () => true
  })
  const publish = (status: WslHostConnectionState) => {
    state.status = status
    listeners.forEach((listener) => listener())
  }
  return { gate, state, reachability, publish }
}

describe('a paired phone and the WSL host', () => {
  let made: ReturnType<typeof makeGate>
  beforeEach(() => {
    made = makeGate()
  })

  it('serves a running host and says it is ready', async () => {
    await made.gate.requireRunningWithoutStart('wsl:ubuntu')
    expect(made.gate.reach('wsl:ubuntu')).toBe('ready')
  })

  it('says the host stopped only when the running list confirmed it', async () => {
    made.state.status = 'reconnecting'
    for (const unconfirmed of ['unavailable', 'unreachable'] as const) {
      made.state.reachability = unconfirmed
      await expect(made.gate.requireRunningWithoutStart('wsl:ubuntu')).rejects.toMatchObject({
        code: 'remote_runtime_unavailable',
        message: NEUTRAL
      })
      expect(made.gate.reach('wsl:ubuntu')).toBe('unavailable')
    }
    made.state.reachability = 'stopped'
    await expect(made.gate.requireRunningWithoutStart('wsl:ubuntu')).rejects.toMatchObject({
      message: STOPPED
    })
    expect(made.gate.reach('wsl:ubuntu')).toBe('stopped')
    // Running again: the desktop's ready status clears the phone's verdict.
    made.publish('ready')
    expect(made.gate.reach('wsl:ubuntu')).toBe('ready')
  })

  it('drops a stopped read that a ready status overtook while it ran', async () => {
    made.state.status = 'reconnecting'
    let finish: (value: WslHostReachability) => void = () => {}
    made.reachability.mockImplementationOnce(
      () => new Promise<WslHostReachability>((resolve) => (finish = resolve))
    )
    const pending = made.gate.requireRunningWithoutStart('wsl:ubuntu')
    await vi.waitFor(() => expect(made.reachability).toHaveBeenCalled())
    made.publish('ready')
    finish('stopped')
    await expect(pending).rejects.toMatchObject({ message: NEUTRAL })
    expect(made.gate.reach('wsl:ubuntu')).toBe('ready')
  })

  it('clears a recorded stop once a check finds the host answering', async () => {
    made.state.status = 'reconnecting'
    made.state.reachability = 'stopped'
    await expect(made.gate.requireRunningWithoutStart('wsl:ubuntu')).rejects.toThrow()
    expect(made.gate.reach('wsl:ubuntu')).toBe('stopped')
    made.state.reachability = 'available'
    await made.gate.requireRunningWithoutStart('wsl:ubuntu')
    expect(made.gate.reach('wsl:ubuntu')).toBe('unavailable')
  })

  it("takes liveness's own confirmed stop, over a stale ready", () => {
    made.publish('distro-stopped')
    expect(made.gate.reach('wsl:ubuntu')).toBe('stopped')
  })

  it('refuses without a running-list read while no bridge exists here', async () => {
    made.state.bridged = false
    made.state.status = 'closed'
    await expect(made.gate.requireRunningWithoutStart('wsl:ubuntu')).rejects.toMatchObject({
      message: NEUTRAL
    })
    expect(made.reachability).not.toHaveBeenCalled()
  })

  it('hides the host while the Experimental switch is off or its Remove is pending', async () => {
    made.state.enabled = false
    expect(made.gate.reach('wsl:ubuntu')).toBe('hidden')
    await expect(made.gate.requireRunningWithoutStart('wsl:ubuntu')).rejects.toMatchObject({
      code: 'remote_runtime_unavailable',
      message: 'The WSL host Ubuntu is turned off or being removed on your computer.'
    })
    made.state.enabled = true
    made.state.pendingStop = true
    expect(made.gate.reach('wsl:ubuntu')).toBe('hidden')
    expect(made.reachability).not.toHaveBeenCalled()
  })
})
