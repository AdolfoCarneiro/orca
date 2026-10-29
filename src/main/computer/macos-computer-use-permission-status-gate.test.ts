import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ComputerUsePermissionStatus,
  ComputerUsePermissionStatusResult
} from '../../shared/computer-use-permissions-types'
import {
  computerUsePermissionStatusGate,
  createPermissionStatusGate
} from './macos-computer-use-permission-status-gate'

const getStatusMock = vi.hoisted(() => vi.fn())

vi.mock('./macos-computer-use-permissions', () => ({
  getComputerUsePermissionStatus: getStatusMock
}))

function statusWith(accessibility: ComputerUsePermissionStatus): ComputerUsePermissionStatusResult {
  return {
    platform: 'darwin',
    helperAppPath: '/Applications/Orca Computer Use.app',
    helperUnavailableReason: null,
    permissions: [
      { id: 'accessibility', status: accessibility },
      { id: 'screenshots', status: 'granted' }
    ]
  }
}

const denied = statusWith('not-granted')
const granted = statusWith('granted')

describe('createPermissionStatusGate', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 0 })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('shares one launch between concurrent readers', async () => {
    const probe = vi.fn(async () => denied)
    const gate = createPermissionStatusGate(probe)

    await Promise.all([gate.read(), gate.read(), gate.read()])
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('caps focus spam and awaited Refresh/RPC loops at one launch per 5s while denied', async () => {
    const probe = vi.fn(async () => denied)
    const gate = createPermissionStatusGate(probe)

    // Fire-and-forget focus reads every 500ms.
    for (let elapsed = 0; elapsed < 60_000; elapsed += 500) {
      void gate.read()
      await vi.advanceTimersByTimeAsync(500)
    }
    expect(probe).toHaveBeenCalledTimes(13)

    // A caller that re-reads as soon as each answer lands.
    const loopEnd = Date.now() + 60_000
    while (Date.now() < loopEnd) {
      let answered = false
      void gate.read().then(() => (answered = true))
      while (!answered) {
        await vi.advanceTimersByTimeAsync(100)
      }
    }
    expect(probe.mock.calls.length - 13).toBeLessThanOrEqual(13)
  })

  it('never serves a denial or error from cache, so a grant shows within one floor', async () => {
    const failure = new Error('Timed out checking permissions')
    const probe = vi
      .fn()
      .mockResolvedValueOnce(denied)
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(granted)
    const gate = createPermissionStatusGate(probe)

    await expect(gate.read()).resolves.toBe(denied)
    await vi.advanceTimersByTimeAsync(1_000)
    const afterDenial = expect(gate.read()).rejects.toBe(failure)
    await vi.advanceTimersByTimeAsync(4_000)
    await afterDenial

    await vi.advanceTimersByTimeAsync(1_000)
    const afterError = gate.read()
    await vi.advanceTimersByTimeAsync(4_000)
    await expect(afterError).resolves.toBe(granted)
    expect(probe).toHaveBeenCalledTimes(3)
  })

  it('serves a grant until the floor expires, then re-checks immediately', async () => {
    const probe = vi.fn(async () => granted)
    const gate = createPermissionStatusGate(probe)

    await gate.read()
    await vi.advanceTimersByTimeAsync(4_999)
    await gate.read()
    expect(probe).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await gate.read()
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('launches no trailing probe without a waiter', async () => {
    const probe = vi.fn(async () => denied)
    const gate = createPermissionStatusGate(probe)

    await gate.read()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('keeps readers off a probe that started before an invalidation, without overlapping helpers', async () => {
    let finishFirst: (result: ComputerUsePermissionStatusResult) => void = () => {}
    const probe = vi
      .fn()
      .mockReturnValueOnce(
        new Promise<ComputerUsePermissionStatusResult>((resolve) => {
          finishFirst = resolve
        })
      )
      .mockResolvedValue(denied)
    const gate = createPermissionStatusGate(probe)

    void gate.read()
    gate.invalidate()
    const afterReset = gate.read()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(probe).toHaveBeenCalledTimes(1)

    finishFirst(granted)
    await vi.advanceTimersByTimeAsync(0)
    await expect(afterReset).resolves.toBe(denied)
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('never lets a stale trailing timer launch inside the floor', async () => {
    const probe = vi.fn(async () => denied)
    const gate = createPermissionStatusGate(probe)

    await gate.read()
    await vi.advanceTimersByTimeAsync(1_000)
    void gate.read()
    // The trailing timer is late: a reader past the floor launches before it fires.
    vi.setSystemTime(5_001)
    await gate.read()
    await vi.advanceTimersByTimeAsync(0)
    void gate.read()
    expect(probe).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(4_999)
    expect(probe).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1_100)
    expect(probe).toHaveBeenCalledTimes(3)
  })

  it('stops reusing a denial for setup once the floor expires', async () => {
    const probe = vi.fn().mockResolvedValueOnce(denied).mockResolvedValueOnce(granted)
    const gate = createPermissionStatusGate(probe)

    await gate.read()
    await expect(gate.peek()).resolves.toBe(denied)
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(gate.peek()).resolves.toBe(granted)
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('sends a late joiner that gets a denial to the next probe', async () => {
    let finishFirst: (result: ComputerUsePermissionStatusResult) => void = () => {}
    const probe = vi
      .fn()
      .mockReturnValueOnce(
        new Promise<ComputerUsePermissionStatusResult>((resolve) => {
          finishFirst = resolve
        })
      )
      .mockResolvedValueOnce(granted)
    const gate = createPermissionStatusGate(probe)

    // A web read starts a probe; the user grants and returns to Orca a second later.
    void gate.read()
    await vi.advanceTimersByTimeAsync(1_000)
    const onReturn = gate.read()
    finishFirst(denied)
    await vi.advanceTimersByTimeAsync(4_000)
    await expect(onReturn).resolves.toBe(granted)
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('does not cache a grant from a probe that started before an invalidation', async () => {
    let finishFirst: (result: ComputerUsePermissionStatusResult) => void = () => {}
    const probe = vi
      .fn()
      .mockReturnValueOnce(
        new Promise<ComputerUsePermissionStatusResult>((resolve) => {
          finishFirst = resolve
        })
      )
      .mockResolvedValue(denied)
    const gate = createPermissionStatusGate(probe)

    void gate.read()
    gate.invalidate()
    finishFirst(granted)
    await vi.advanceTimersByTimeAsync(1_000)
    const afterReset = gate.read()
    await vi.advanceTimersByTimeAsync(4_000)
    await expect(afterReset).resolves.toBe(denied)
  })
})

describe('computerUsePermissionStatusGate', () => {
  const originalPlatform = process.platform

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
  })

  it('never waits off macOS, where the probe launches no helper', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    getStatusMock.mockResolvedValue(statusWith('unsupported'))

    await computerUsePermissionStatusGate.read()
    await computerUsePermissionStatusGate.read()
    await computerUsePermissionStatusGate.read()
    expect(getStatusMock).toHaveBeenCalledTimes(3)
  })
})
