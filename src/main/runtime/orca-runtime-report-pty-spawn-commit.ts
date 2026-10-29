import type { TerminalCreateOptions } from './runtime-terminal-contracts'

export function createIdempotentCallback(callback?: () => void): () => void {
  let reported = false
  return () => {
    if (reported) {
      return
    }
    reported = true
    callback?.()
  }
}

/** Observe the admitted dispatch using the identity and effective recipe sent to spawn. */
export function reportTerminalSpawnDispatched(
  opts: TerminalCreateOptions,
  launch: () => NonNullable<
    Parameters<NonNullable<TerminalCreateOptions['onPtySpawnDispatched']>>[0]
  >
): () => void {
  return () => {
    opts.beforePtySpawn?.()
    opts.onPtySpawnDispatched?.(launch())
  }
}
