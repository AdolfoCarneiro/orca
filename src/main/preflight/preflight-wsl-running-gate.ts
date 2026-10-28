import { listWslDistrosAsync } from '../wsl'
import { assertWslUncPathRunning } from '../wsl/wsl-unc-access-gate'
import type { WslPreflightTarget } from '../ipc/preflight-wsl-agent-detection'

/**
 * Preflight and agent detection run on mount, focus and timers: background work that must not boot
 * a stopped distro (E9). Throws the gate's "not running" error, which callers show and retry.
 */
export async function assertPreflightWslDistroRunning(target: WslPreflightTarget): Promise<void> {
  // No distro named means wsl.exe's default, which a probe would boot just the same.
  const distro = target.distro?.trim() || (await listWslDistrosAsync())[0]
  if (distro) {
    await assertWslUncPathRunning('', distro)
  }
}
