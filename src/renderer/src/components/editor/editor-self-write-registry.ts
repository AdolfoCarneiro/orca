import { normalizeAbsolutePathForComparison } from '@/components/right-sidebar/file-explorer-paths'
import { MAX_TIMER_DELAY_MS } from '../../../../shared/timer-delay'

// Self-write echoes can reload TipTap, resetting selection and dropping typing; bound owner/path stamps so later external edits remain visible.
const SELF_WRITE_TTL_MS = 750
// Remote watcher polling and network delays outlast the local echo window.
export const SELF_WRITE_REMOTE_TTL_MS = 3000
const SELF_WRITE_MAX_STAMPS = 256

export type RecentSelfWrite = {
  content: string | null
}

export type EditorSelfWritePath = {
  filePath: string
  runtimeEnvironmentId?: string | null
}

type SelfWriteStamp = RecentSelfWrite & {
  expiresAt: number
}

const stamps = new Map<string, SelfWriteStamp>()
let expiryTimer: ReturnType<typeof setTimeout> | null = null
let scheduledExpiryAt = Infinity

function clearExpiryTimer(): void {
  if (expiryTimer !== null) {
    clearTimeout(expiryTimer)
    expiryTimer = null
  }
  scheduledExpiryAt = Infinity
}

function scheduleExpiredSelfWriteCleanup(): void {
  let nextExpiryAt = Infinity
  for (const stamp of stamps.values()) {
    if (Number.isFinite(stamp.expiresAt)) {
      nextExpiryAt = Math.min(nextExpiryAt, stamp.expiresAt + 1)
    }
  }
  if (nextExpiryAt === Infinity) {
    clearExpiryTimer()
    return
  }
  if (expiryTimer !== null && scheduledExpiryAt <= nextExpiryAt) {
    return
  }
  clearExpiryTimer()
  scheduledExpiryAt = nextExpiryAt
  expiryTimer = setTimeout(
    () => {
      expiryTimer = null
      scheduledExpiryAt = Infinity
      pruneExpiredSelfWrites()
      scheduleExpiredSelfWriteCleanup()
    },
    Math.min(MAX_TIMER_DELAY_MS, Math.max(0, nextExpiryAt - Date.now()))
  )
}

function selfWriteKey(absolutePath: string, runtimeEnvironmentId?: string | null): string {
  return `${runtimeEnvironmentId?.trim() || 'client'}::${normalizeAbsolutePathForComparison(absolutePath)}`
}

function pruneExpiredSelfWrites(now = Date.now()): void {
  for (const [key, stamp] of stamps) {
    if (now > stamp.expiresAt) {
      stamps.delete(key)
    }
  }
}

function enforceSelfWriteStampLimit(): void {
  while (stamps.size > SELF_WRITE_MAX_STAMPS) {
    const oldest = stamps.keys().next().value
    if (oldest === undefined) {
      break
    }
    stamps.delete(oldest)
  }
}

export function recordSelfWrite(
  absolutePath: string,
  content?: string,
  runtimeEnvironmentId?: string | null,
  ttlMs: number = SELF_WRITE_TTL_MS
): void {
  const now = Date.now()
  pruneExpiredSelfWrites(now)
  const key = selfWriteKey(absolutePath, runtimeEnvironmentId)
  // Bound retention even when no watcher echo arrives.
  stamps.delete(key)
  stamps.set(key, {
    content: content ?? null,
    expiresAt: now + ttlMs
  })
  enforceSelfWriteStampLimit()
  scheduleExpiredSelfWriteCleanup()
}

function clearSelfWriteKey(key: string): void {
  stamps.delete(key)
  if (stamps.size === 0) {
    clearExpiryTimer()
  }
}

export function clearSelfWrite(absolutePath: string, runtimeEnvironmentId?: string | null): void {
  clearSelfWriteKey(selfWriteKey(absolutePath, runtimeEnvironmentId))
}

const noSelfWriteToInvalidate = (): void => {}

export function createSelfWriteInvalidationCapture(paths: Iterable<EditorSelfWritePath>) {
  const keys = new Set<string>()
  const addPaths = (paths: Iterable<EditorSelfWritePath>): void => {
    for (const path of paths) {
      keys.add(selfWriteKey(path.filePath, path.runtimeEnvironmentId))
    }
  }
  addPaths(paths)
  return {
    addPaths,
    capture: (): (() => void) => {
      pruneExpiredSelfWrites()
      if (stamps.size === 0) {
        keys.clear()
        clearExpiryTimer()
        return noSelfWriteToInvalidate
      }
      const captured = new Map<string, WeakRef<SelfWriteStamp>>()
      for (const key of keys) {
        const stamp = stamps.get(key)
        if (stamp) {
          captured.set(key, new WeakRef(stamp))
        }
      }
      keys.clear()
      if (captured.size === 0) {
        return noSelfWriteToInvalidate
      }
      return () => {
        for (const [key, reference] of captured) {
          const stamp = reference.deref()
          // Explicit saves may replace the drained stamp while Git is pending.
          if (stamp && stamps.get(key) === stamp) {
            clearSelfWriteKey(key)
          }
        }
        captured.clear()
      }
    }
  }
}

export function getRecentSelfWrite(
  absolutePath: string,
  runtimeEnvironmentId?: string | null
): RecentSelfWrite | null {
  const key = selfWriteKey(absolutePath, runtimeEnvironmentId)
  const stamp = stamps.get(key)
  if (!stamp) {
    return null
  }
  if (Date.now() > stamp.expiresAt) {
    stamps.delete(key)
    if (stamps.size === 0) {
      clearExpiryTimer()
    }
    return null
  }
  return { content: stamp.content }
}

export function hasRecentSelfWrite(
  absolutePath: string,
  runtimeEnvironmentId?: string | null
): boolean {
  return getRecentSelfWrite(absolutePath, runtimeEnvironmentId) !== null
}

export function __clearSelfWriteRegistryForTests(): void {
  clearExpiryTimer()
  stamps.clear()
}

export function __getSelfWriteRegistrySizeForTests(): number {
  return stamps.size
}
