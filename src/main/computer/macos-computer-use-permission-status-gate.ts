import type { ComputerUsePermissionStatusResult } from '../../shared/computer-use-permissions-types'

// Each macOS probe launches a helper that polls TCC for ~3.5s; denied answers only change on user action.
export const PERMISSION_STATUS_GRANTED_REUSE_MS = 2_000
export const PERMISSION_STATUS_DENIED_MIN_BACKOFF_MS = 10_000
export const PERMISSION_STATUS_DENIED_MAX_BACKOFF_MS = 120_000

type ProbeOutcome =
  | { ok: true; result: ComputerUsePermissionStatusResult }
  | { ok: false; error: unknown }

export type PermissionStatusProbeGate = {
  read: () => Promise<ComputerUsePermissionStatusResult>
  noteActivation: () => void
  invalidate: () => void
}

export function createPermissionStatusProbeGate(options: {
  probe: () => Promise<ComputerUsePermissionStatusResult>
  now?: () => number
}): PermissionStatusProbeGate {
  const now = options.now ?? Date.now
  let inFlight: Promise<ComputerUsePermissionStatusResult> | null = null
  let cached: ProbeOutcome | null = null
  let lastProbeAt = 0
  let reuseUntil = 0
  let deniedStreak = 0
  let generation = 0

  const runProbe = (): Promise<ComputerUsePermissionStatusResult> => {
    const probeGeneration = generation
    const tracked = options
      .probe()
      .then(
        (result) => {
          if (probeGeneration === generation) {
            recordOutcome({ ok: true, result })
          }
          return result
        },
        (error: unknown) => {
          if (probeGeneration === generation) {
            recordOutcome({ ok: false, error })
          }
          throw error
        }
      )
      .finally(() => {
        if (inFlight === tracked) {
          inFlight = null
        }
      })
    inFlight = tracked
    return tracked
  }

  const recordOutcome = (outcome: ProbeOutcome): void => {
    cached = outcome
    lastProbeAt = now()
    if (outcome.ok && !isMissingPermission(outcome.result)) {
      deniedStreak = 0
      reuseUntil = lastProbeAt + PERMISSION_STATUS_GRANTED_REUSE_MS
      return
    }
    deniedStreak += 1
    const backoff = PERMISSION_STATUS_DENIED_MIN_BACKOFF_MS * 2 ** (deniedStreak - 1)
    reuseUntil = lastProbeAt + Math.min(backoff, PERMISSION_STATUS_DENIED_MAX_BACKOFF_MS)
  }

  return {
    read: () => {
      if (inFlight) {
        return inFlight
      }
      if (cached && now() < reuseUntil) {
        return cached.ok ? Promise.resolve(cached.result) : Promise.reject(cached.error)
      }
      return runProbe()
    },
    noteActivation: () => {
      // Returning to Orca is when a grant made in System Settings can land; still keep a floor.
      reuseUntil = Math.min(reuseUntil, lastProbeAt + PERMISSION_STATUS_DENIED_MIN_BACKOFF_MS)
    },
    invalidate: () => {
      generation += 1
      inFlight = null
      cached = null
      reuseUntil = 0
      deniedStreak = 0
    }
  }
}

function isMissingPermission(result: ComputerUsePermissionStatusResult): boolean {
  return (
    result.helperUnavailableReason === null &&
    result.permissions.some((permission) => permission.status === 'not-granted')
  )
}

export const computerUsePermissionStatusGate = createPermissionStatusProbeGate({
  probe: async () => {
    const { getComputerUsePermissionStatus } = await import('./macos-computer-use-permissions')
    return getComputerUsePermissionStatus()
  }
})
