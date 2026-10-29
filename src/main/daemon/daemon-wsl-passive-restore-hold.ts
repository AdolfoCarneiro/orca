import { readWslDistroRunningState } from '../wsl-background-distro-gate'
import { wslDistroHoldMessage } from '../../shared/wsl-distro-stopped-hold'
import type { PtySpawnOptions } from '../providers/pty-provider-contract'

/** A provider hold right after the startup-target hold reuses that read instead of probing again. */
export const WSL_PROVIDER_HOLD_LEASE_MS = 5_000

/**
 * Launch restore, a reload, a remount or main's background start (orchestration, automations,
 * recovery) the user did not ask for would start a stopped distro's `wsl.exe` (E9). It starts
 * only when a settled read proves the distro running; a stopped or unanswered read holds it
 * until the user's Start.
 */
export async function holdPassiveRestoreOfStoppedWslDistro(
  opts: Pick<
    PtySpawnOptions,
    'wslPassiveRestore' | 'wslBackgroundStart' | 'sessionId' | 'isNewSession' | 'attachOnly'
  >,
  wslDistro: string | undefined,
  /** Accept a running-list read started within this window (a noted stop still forces a new one). */
  options: { leaseMs?: number } = {}
): Promise<void> {
  const passiveRestore =
    opts.wslPassiveRestore === true && Boolean(opts.sessionId) && opts.isNewSession !== true
  // Background work holds fresh starts too: a new session's `wsl.exe` starts the distro as well.
  if (!wslDistro || opts.attachOnly === true || !(passiveRestore || opts.wslBackgroundStart)) {
    return
  }
  const state = await readWslDistroRunningState(wslDistro, {
    ...(options.leaseMs === undefined ? {} : { startedAfter: performance.now() - options.leaseMs }),
    retryUnverifiable: true
  })
  if (state !== 'running') {
    throw new Error(wslDistroHoldMessage(wslDistro, state))
  }
}
