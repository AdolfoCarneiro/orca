import { lastUserWorkspaceSwitchAt } from '@/lib/workspace-switch-user-act'
import { holdPaneForStoppedWslDistro } from '../wsl-distro-stopped-hold-state'
import { recordPtyConnectDiagnostic } from './pty-connect-limits'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

// Clears the saved screen the hold painted so the restore below paints it once.
const CLEAR_HELD_SCREEN = '\x1b[0m\x1b[2J\x1b[3J\x1b[H'

/**
 * How a local restore may start a stopped WSL distro: Start passes nothing (the user's act); with no
 * switch to the workspace it is passive; otherwise main counts the switch only if it followed the
 * distro's last stop, so a later remount or background mount cannot boot it. Never on a server.
 */
export function wslRestoreStartArgs(
  session: ConnectPanePtySession,
  userAct: boolean
): { wslPassiveRestore?: true; wslUserSwitchAt?: number } {
  if (session.runtimeEnvironmentId || userAct) {
    return {}
  }
  const switchedAt = lastUserWorkspaceSwitchAt(session.deps.worktreeId)
  return switchedAt === undefined ? { wslPassiveRestore: true } : { wslUserSwitchAt: switchedAt }
}

/** Hold the pane read-only with its saved screen until the user's Start reconnects it. */
export function holdForStoppedWslDistro(
  session: ConnectPanePtySession,
  sessionId: string,
  distro: string,
  reconnect: () => Promise<unknown>
): void {
  recordPtyConnectDiagnostic(`pane=${session.pane.id} -> HELD FOR STOPPED WSL ${distro}`)
  const generation = session.transportStreamGeneration
  const terminal = session.pane.terminal
  const isCurrent = (): boolean =>
    !session.disposed &&
    generation === session.transportStreamGeneration &&
    session.deps.paneTransportsRef.current.get(session.pane.id) === session.transport
  let held = true
  let paintedScreen = false
  // Why: nothing backs this pane, so keystrokes have nowhere to go.
  terminal.options.disableStdin = true
  const forget = holdPaneForStoppedWslDistro(session.cacheKey, {
    distro,
    release: async () => {
      held = false
      if (!isCurrent()) {
        return
      }
      terminal.options.disableStdin = false
      if (paintedScreen) {
        session.writeReplayData(CLEAR_HELD_SCREEN)
      }
      await reconnect()
    }
  })
  session.waitTeardowns.push(forget)
  // The same read-only history read a newer-daemon hold paints, from this machine's daemon history.
  void window.api.pty
    .readNewerDaemonHeldScreen(sessionId)
    .catch(() => null)
    .then((screen) => {
      if (screen && held && isCurrent()) {
        paintedScreen = true
        session.writeReplayData(screen.scrollback)
      }
    })
}
