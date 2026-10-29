import { describe, expect, it, vi } from 'vitest'
import type { ComputerUsePermissionStatusResult } from '../../shared/computer-use-permissions-types'
import {
  createPermissionStatusProbeGate,
  PERMISSION_STATUS_DENIED_MAX_BACKOFF_MS,
  PERMISSION_STATUS_DENIED_MIN_BACKOFF_MS
} from './macos-computer-use-permission-status-gate'

const denied: ComputerUsePermissionStatusResult = {
  platform: 'darwin',
  helperAppPath: '/Applications/Orca Computer Use.app',
  helperUnavailableReason: null,
  permissions: [
    { id: 'accessibility', status: 'not-granted' },
    { id: 'screenshots', status: 'granted' }
  ]
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
    expect(probe).toHaveBeenCalledTimes(9)
    gate.noteActivation()
    clock += PERMISSION_STATUS_DENIED_MIN_BACKOFF_MS - 1
    await gate.read()
    expect(probe).toHaveBeenCalledTimes(9)

    gate.invalidate()
    await gate.read()
    expect(probe).toHaveBeenCalledTimes(10)
  })
})
