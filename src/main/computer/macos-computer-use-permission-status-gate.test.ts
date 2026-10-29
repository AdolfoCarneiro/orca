import { describe, expect, it, vi } from 'vitest'
import type {
  ComputerUsePermissionStatus,
  ComputerUsePermissionStatusResult
} from '../../shared/computer-use-permissions-types'
import {
  createPermissionStatusProbeGate,
  PERMISSION_STATUS_DENIED_MAX_BACKOFF_MS,
  PERMISSION_STATUS_RESULT_REUSE_MS
} from './macos-computer-use-permission-status-gate'

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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

describe('createPermissionStatusProbeGate', () => {
  it('stops relaunching the helper while Accessibility stays denied (#34390)', async () => {
    let clock = 0
    const probe = vi.fn(async () => denied)
    const gate = createPermissionStatusProbeGate({ probe, now: () => clock })

    // Three always-mounted setup-guide hooks read on every window focus.
    await Promise.all([gate.read(), gate.read(), gate.read()])
    expect(probe).toHaveBeenCalledTimes(1)

    for (let elapsed = 0; elapsed < PERMISSION_STATUS_DENIED_MAX_BACKOFF_MS * 5; elapsed += 500) {
      clock += 500
      await gate.read()
    }
    // Backoff 10s, 20s, 40s, 80s, then 120s cap: 8 launches in 10 minutes instead of 1,200.
    expect(probe).toHaveBeenCalledTimes(8)

    gate.noteActivation()
    await gate.read()
    expect(probe).toHaveBeenCalledTimes(8)
  })

  it('re-probes once per return to Orca so a grant or revocation shows immediately', async () => {
    const probe = vi.fn().mockResolvedValueOnce(denied).mockResolvedValueOnce(granted)
    const gate = createPermissionStatusProbeGate({ probe, now: () => 0 })

    await expect(gate.read()).resolves.toBe(denied)
    gate.noteBlur()
    gate.noteActivation()
    const reads = await Promise.all([gate.read(), gate.read(), gate.read()])
    expect(reads).toEqual([granted, granted, granted])
    expect(probe).toHaveBeenCalledTimes(2)

    probe.mockResolvedValueOnce(denied)
    gate.noteBlur()
    gate.noteActivation()
    await expect(gate.read()).resolves.toBe(denied)
    expect(probe).toHaveBeenCalledTimes(3)
  })

  it('lets a fresh remote read bypass the denied backoff', async () => {
    let clock = 0
    const probe = vi.fn().mockResolvedValueOnce(denied).mockResolvedValueOnce(granted)
    const gate = createPermissionStatusProbeGate({ probe, now: () => clock })

    await gate.read()
    clock += PERMISSION_STATUS_RESULT_REUSE_MS - 1
    await expect(gate.read({ fresh: true })).resolves.toBe(denied)
    clock += 1
    await expect(gate.read()).resolves.toBe(denied)
    await expect(gate.read({ fresh: true })).resolves.toBe(granted)
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('re-probes after an in-flight check is invalidated without overlapping helpers', async () => {
    const first = deferred<ComputerUsePermissionStatusResult>()
    const probe = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce(denied)
    const gate = createPermissionStatusProbeGate({ probe, now: () => 0 })

    const stale = gate.read()
    gate.invalidate()
    const current = gate.read()
    expect(probe).toHaveBeenCalledTimes(1)

    first.resolve(granted)
    await expect(stale).resolves.toBe(granted)
    await expect(current).resolves.toBe(denied)
    expect(probe).toHaveBeenCalledTimes(2)
    await expect(gate.read()).resolves.toBe(denied)
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('shares a failed check briefly instead of backing it off like a denial', async () => {
    let clock = 0
    const failure = new Error('Timed out checking permissions')
    const probe = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(granted)
    const gate = createPermissionStatusProbeGate({ probe, now: () => clock })

    const results = await Promise.allSettled([gate.read(), gate.read()])
    expect(results).toEqual([
      { status: 'rejected', reason: failure },
      { status: 'rejected', reason: failure }
    ])
    expect(probe).toHaveBeenCalledTimes(1)

    clock += PERMISSION_STATUS_RESULT_REUSE_MS
    await expect(gate.read()).resolves.toBe(granted)
    expect(probe).toHaveBeenCalledTimes(2)
  })
})
