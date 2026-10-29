import { readWslDistroRunningState, wslDistroStopNotedAt } from '../wsl-background-distro-gate'
import { wslDistroStoppedHoldMessage } from '../../shared/wsl-distro-stopped-hold'
import type { PtySpawnOptions } from '../providers/pty-provider-contract'

type RestoreStart = Pick<
  PtySpawnOptions,
  'wslPassiveRestore' | 'wslUserSwitchAt' | 'sessionId' | 'isNewSession' | 'attachOnly'
>

/** Whether the restore may start the distro without asking: a user's switch made after its last stop. */
function restoreStartsByUserAct(opts: RestoreStart, wslDistro: string): boolean {
  if (opts.wslPassiveRestore === true) {
    return false
  }
  if (opts.wslUserSwitchAt === undefined) {
    // Start, or a window that predates the fields: as before.
    return true
  }
  const stoppedAt = wslDistroStopNotedAt(wslDistro)
  return stoppedAt === undefined || opts.wslUserSwitchAt > stoppedAt
}

/**
 * Launch restore, a reload, or a remount after the distro stopped would start its `wsl.exe` with no
 * user act (E9). Only a confirmed stop holds the pane; an unanswered read spawns as before.
 */
export async function holdPassiveRestoreOfStoppedWslDistro(
  opts: RestoreStart,
  wslDistro: string | undefined
): Promise<void> {
  if (
    !wslDistro ||
    !opts.sessionId ||
    opts.isNewSession === true ||
    opts.attachOnly === true ||
    restoreStartsByUserAct(opts, wslDistro)
  ) {
    return
  }
  if ((await readWslDistroRunningState(wslDistro, { retryUnverifiable: true })) === 'stopped') {
    throw new Error(wslDistroStoppedHoldMessage(wslDistro))
  }
}
