import type { ComputerUsePermissionStatusResult } from '../../shared/computer-use-permissions-types'

// Each macOS probe launches a helper that settles TCC for ~2s; one launch per 5s caps every path at 12/min.
const PERMISSION_STATUS_LAUNCH_FLOOR_MS = 5_000

type StatusResult = ComputerUsePermissionStatusResult

export type PermissionStatusGate = {
  read: () => Promise<StatusResult>
  // Setup's cheapest answer: in-flight, recent grant or last denial, before launching anything new.
  peek: () => Promise<StatusResult>
  invalidate: () => void
}

export function createPermissionStatusGate(
  probe: () => Promise<StatusResult>
): PermissionStatusGate {
  let inFlight: { promise: Promise<StatusResult>; joinable: boolean } | null = null
  let lastLaunchAt = Number.NEGATIVE_INFINITY
  // Only grants are cached; a denial or error is never served, so a fresh grant shows within one floor.
  let granted: StatusResult | null = null
  // Setup may act on a stale denial: it launches the helper either way.
  let lastDenied: StatusResult | null = null
  let waiters: {
    promise: Promise<StatusResult>
    resolve: (next: Promise<StatusResult>) => void
  } | null = null
  let trailingTimer: ReturnType<typeof setTimeout> | null = null

  const floorExpiresAt = (): number => lastLaunchAt + PERMISSION_STATUS_LAUNCH_FLOOR_MS

  const armTrailing = (): void => {
    if (!waiters || inFlight || trailingTimer) {
      return
    }
    trailingTimer = setTimeout(
      () => {
        trailingTimer = null
        if (waiters && !inFlight) {
          void launch().catch(() => {})
        }
      },
      Math.max(0, floorExpiresAt() - Date.now())
    )
    trailingTimer.unref?.()
  }

  const launch = (): Promise<StatusResult> => {
    lastLaunchAt = Date.now()
    const entry = { promise: probe(), joinable: true }
    inFlight = entry
    entry.promise
      .then(
        (result) => {
          if (entry.joinable) {
            granted = isCacheable(result) ? result : null
            lastDenied = granted ? null : result
          }
        },
        () => {
          granted = null
        }
      )
      .finally(() => {
        if (inFlight === entry) {
          inFlight = null
        }
        armTrailing()
      })
    // Readers waiting out the floor take whichever probe starts next, whatever triggered it.
    const pending = waiters
    waiters = null
    pending?.resolve(entry.promise)
    return entry.promise
  }

  const read = (): Promise<StatusResult> => {
    if (granted && Date.now() < floorExpiresAt()) {
      return Promise.resolve(granted)
    }
    if (inFlight?.joinable) {
      return inFlight.promise
    }
    if (!inFlight && Date.now() >= floorExpiresAt()) {
      return launch()
    }
    if (!waiters) {
      let resolve: (next: Promise<StatusResult>) => void = () => {}
      const promise = new Promise<StatusResult>((settle) => {
        resolve = settle
      })
      waiters = { promise, resolve }
    }
    armTrailing()
    return waiters.promise
  }

  return {
    read,
    peek: () => {
      if (inFlight?.joinable) {
        return inFlight.promise
      }
      if (granted && Date.now() < floorExpiresAt()) {
        return Promise.resolve(granted)
      }
      return lastDenied ? Promise.resolve(lastDenied) : read()
    },
    invalidate: () => {
      granted = null
      lastDenied = null
      if (inFlight) {
        inFlight.joinable = false
      }
    }
  }
}

// A missing helper answers without launching anything, so it is as safe to reuse as a grant.
function isCacheable(result: StatusResult): boolean {
  return (
    result.helperUnavailableReason !== null ||
    result.permissions.every((permission) => permission.status !== 'not-granted')
  )
}

async function probeStatus(): Promise<StatusResult> {
  const { getComputerUsePermissionStatus } = await import('./macos-computer-use-permissions')
  return getComputerUsePermissionStatus()
}

const macosGate = createPermissionStatusGate(probeStatus)

// Off macOS the probe answers 'unsupported' instantly without a helper, so it skips the gate.
export const computerUsePermissionStatusGate: PermissionStatusGate = {
  read: () => (process.platform === 'darwin' ? macosGate.read() : probeStatus()),
  peek: () => (process.platform === 'darwin' ? macosGate.peek() : probeStatus()),
  invalidate: () => macosGate.invalidate()
}
