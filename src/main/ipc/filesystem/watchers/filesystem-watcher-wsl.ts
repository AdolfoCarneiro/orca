/** Poll inside WSL so distro shutdown kills the watcher instead of Windows UNC polling repeatedly waking it. */
import type { PipedChildProcess } from '@orca/process-host/process-spec'
import { StringDecoder } from 'node:string_decoder'
import { createWslSnapshotStream, type WslSnapshot } from './wsl-watcher-snapshot-stream'
import type { WebContents } from 'electron'
import type { Event as WatcherEvent } from '@parcel/watcher'
import { queueWatcherEvents } from './filesystem-watcher-event-batch'
import { parseWslUncPath } from '../../../../shared/wsl-paths'
import { createWslWatcherProcessExit, createWslWatcherStartup } from './wsl-watcher-process-exit'
import * as watcherChildRegistry from '../watcher-process/parcel-watcher-child-registry'
import { createDebouncedBatch, type DebouncedBatch } from './filesystem-watcher-batch-control'
import { spawnWslWatcherProcess } from './wsl-watcher-spawn'

export type WatcherSubscription = {
  unsubscribe(): Promise<void>
}

export type WatchedRoot = {
  subscription: WatcherSubscription
  listeners: Map<number, WebContents>
  batch: DebouncedBatch
  // Renderer paths must use real spelling, never folded comparison keys.
  rootPath: string
}

export type WslWatcherDeps = {
  ignoreDirs: string[]
  scheduleBatchFlush: (root: WatchedRoot) => void
  watchedRoots: Map<string, WatchedRoot>
  /** The child died on its own, e.g. the distro stopped; runs before the overflow refresh. */
  onUnexpectedStop?: (root: WatchedRoot, distro: string) => void
}

const POLL_INTERVAL_SECONDS = 2
const STARTUP_TIMEOUT_MS = 10_000
const [SNAPSHOT_START, SNAPSHOT_END] = ['\x1e', '\x1f']
function quoteSafeFindName(name: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
    throw new Error(`Unsupported WSL watcher ignore name: ${name}`)
  }
  return `'${name}'`
}

function buildPruneExpression(ignoreDirs: readonly string[]): string {
  if (ignoreDirs.length === 0) {
    return ''
  }
  const names = ignoreDirs.map((name) => `-name ${quoteSafeFindName(name)}`).join(' -o ')
  return `\\( -type d \\( ${names} \\) -prune \\) -o`
}

function buildSnapshotScript(ignoreDirs: readonly string[]): string {
  const prune = buildPruneExpression(ignoreDirs)
  return [
    'set -efu',
    'root=$1',
    'while :; do',
    "  printf '\\036'",
    '  if [ -d "$root" ]; then',
    `    find "$root" -mindepth 1 -maxdepth 2 ${prune} -printf '%y\\t%T@\\t%p\\0' 2>/dev/null || true`,
    '  fi',
    "  printf '\\037'",
    `  sleep ${POLL_INTERVAL_SECONDS} || exit 0`,
    'done'
  ].join('\n')
}

function diffSnapshots(prev: WslSnapshot, next: WslSnapshot): WatcherEvent[] {
  const events: WatcherEvent[] = []

  for (const [entryPath, nextEntry] of next) {
    const prevEntry = prev.get(entryPath)
    if (!prevEntry) {
      events.push({ type: 'create', path: entryPath } as WatcherEvent)
      continue
    }
    if (prevEntry.type !== nextEntry.type) {
      events.push({ type: 'delete', path: entryPath } as WatcherEvent)
      events.push({ type: 'create', path: entryPath } as WatcherEvent)
      continue
    }
    if (prevEntry.mtime !== nextEntry.mtime) {
      events.push({ type: 'update', path: entryPath } as WatcherEvent)
    }
  }

  for (const entryPath of prev.keys()) {
    if (!next.has(entryPath)) {
      events.push({ type: 'delete', path: entryPath } as WatcherEvent)
    }
  }

  return events
}

function markOverflowWithoutUncStat(root: WatchedRoot): void {
  if (root.batch.timer) {
    clearTimeout(root.batch.timer)
    root.batch.timer = null
  }
  root.batch.events = []
  root.batch.overflowed = true
}

export async function createWslWatcher(
  rootKey: string,
  worktreePath: string,
  deps: WslWatcherDeps,
  signal?: AbortSignal
): Promise<WatchedRoot> {
  if (signal?.aborted) {
    throw new DOMException('WSL watcher subscription aborted', 'AbortError')
  }

  const wsl = parseWslUncPath(worktreePath)
  if (!wsl) {
    throw new Error(`Not a WSL path: ${worktreePath}`)
  }
  const { distro, linuxPath } = wsl

  const root: WatchedRoot = {
    subscription: null!,
    listeners: new Map(),
    batch: createDebouncedBatch(),
    rootPath: worktreePath
  }

  let disposed = false
  let prevSnapshot: WslSnapshot | null = null
  let stopped = false
  const stdoutDecoder = new StringDecoder('utf8')
  const stderrDecoder = new StringDecoder('utf8')
  let stderrTail = ''

  const startup = createWslWatcherStartup()

  function signalWatcherStopped(): void {
    if (stopped) {
      return
    }
    if (!prevSnapshot) {
      return
    }
    stopped = true
    snapshotStream.dispose()
    // First: the overflow refresh below reads the root, which would boot a just-stopped distro.
    deps.onUnexpectedStop?.(root, distro)
    markOverflowWithoutUncStat(root)
    deps.scheduleBatchFlush(root)
    deps.watchedRoots.delete(rootKey)
  }

  function ingestSnapshot(nextSnapshot: WslSnapshot): void {
    if (root.batch.cancelled) {
      return
    }
    if (!prevSnapshot) {
      prevSnapshot = nextSnapshot
      startup.settle()
      return
    }
    const events = diffSnapshots(prevSnapshot, nextSnapshot)
    prevSnapshot = nextSnapshot

    if (events.length > 0) {
      queueWatcherEvents(root.batch, events)
      deps.scheduleBatchFlush(root)
    }
  }

  const snapshotStream = createWslSnapshotStream(
    distro,
    SNAPSHOT_START,
    SNAPSHOT_END,
    ingestSnapshot,
    () => {
      markOverflowWithoutUncStat(root)
      deps.scheduleBatchFlush(root)
    }
  )

  let child: PipedChildProcess
  const releaseChildReservation = watcherChildRegistry.reserveWatcherChild()
  if (!releaseChildReservation) {
    throw new watcherChildRegistry.WatcherChildCapacityError()
  }
  try {
    child = spawnWslWatcherProcess(distro, linuxPath)
  } catch (error) {
    releaseChildReservation()
    throw error instanceof Error ? error : new Error(String(error))
  }

  // Release process capacity only on the same physical-exit proof required for destructive cleanup.
  const processExit = createWslWatcherProcessExit(child, worktreePath, releaseChildReservation)

  const onAbort = (): void => {
    snapshotStream.dispose()
    startup.settle(new DOMException('WSL watcher subscription aborted', 'AbortError'))
    processExit.requestStopBestEffort()
  }
  signal?.addEventListener('abort', onAbort, { once: true })

  const startupTimer = setTimeout(() => {
    snapshotStream.dispose()
    startup.settle(new Error(`Timed out starting WSL watcher for ${worktreePath}`))
    processExit.requestStopBestEffort()
  }, STARTUP_TIMEOUT_MS)

  child.stdin.on('error', (error) => {
    // Early WSL exit can break stdin; reject setup on EPIPE instead of crashing on a stream error.
    if (!startup.settled) {
      startup.settle(error)
    }
  })

  child.stdout.on('data', (chunk: Buffer) => {
    if (disposed) {
      return
    }
    snapshotStream.write(stdoutDecoder.write(chunk))
  })

  child.stderr.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + stderrDecoder.write(chunk)).slice(-4096)
  })

  child.stdout.on('error', (error) => {
    if (!startup.settled) {
      startup.settle(error)
      return
    }
    if (!disposed) {
      signalWatcherStopped()
    }
  })

  child.stderr.on('error', () => {
    // Ignore diagnostic stream failures; stdout/close determine watcher state.
  })

  child.once('error', (error) => {
    // Failed spawns without a PID need no exit wait; spawned children still require close proof.
    if (child.pid === undefined) {
      processExit.markPhysicalExit()
    }
    if (!startup.settled) {
      startup.settle(error)
      return
    }
    if (!disposed) {
      signalWatcherStopped()
    }
  })

  child.once('close', (code, signal) => {
    snapshotStream.dispose()
    processExit.markPhysicalExit()
    if (!startup.settled) {
      const suffix = stderrTail.trim() ? `: ${stderrTail.trim()}` : ''
      startup.settle(
        new Error(`WSL watcher exited before first snapshot (${code ?? signal})${suffix}`)
      )
      return
    }
    if (!disposed) {
      signalWatcherStopped()
    }
  })

  try {
    child.stdin.end(buildSnapshotScript(deps.ignoreDirs))
    await startup.ready
  } catch (error) {
    snapshotStream.dispose()
    // Destructive cancellation must retain ownership until WSL confirms physical exit.
    startup.settle(error instanceof Error ? error : new Error(String(error)))
    await startup.ready.catch(() => undefined)
    await processExit.stopAndWait()
    throw error
  } finally {
    clearTimeout(startupTimer)
    signal?.removeEventListener('abort', onAbort)
  }

  root.subscription = {
    unsubscribe: async () => {
      disposed = true
      snapshotStream.dispose()
      await processExit.stopAndWait()
    }
  }

  return root
}
