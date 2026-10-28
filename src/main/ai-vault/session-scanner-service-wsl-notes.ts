import type { ChildProcess } from 'node:child_process'
import { onWslDistroGateNote } from '../wsl-background-distro-gate'

/**
 * The child's transcript gate cannot hear main's WSL stop and wake notes; without them it trusts a
 * running read for its whole lease. Returns the unsubscribe.
 */
export function forwardWslDistroNotesToChild(child: () => ChildProcess | null): () => void {
  return onWslDistroGateNote((note) =>
    child()?.send({ type: 'wslDistroNote', ...note }, () => undefined)
  )
}
