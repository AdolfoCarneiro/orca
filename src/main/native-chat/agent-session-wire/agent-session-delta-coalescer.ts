import {
  AGENT_SESSION_STREAMED_TEXT_MAX_BYTES,
  AGENT_SESSION_STREAMED_TEXT_TOTAL_MAX_BYTES,
  appendWithinUtf8ByteLimit
} from './agent-session-text-prefix'
// Coalesce token deltas into text snapshots to reduce journal writes and subscriber frames.
// Flush text before lifecycle events so completion/approval rows cannot overtake preceding text.

export const AGENT_SESSION_DELTA_COALESCE_MS = 60
export const AGENT_SESSION_TEXT_CHECKPOINT_MS = 400

/** Bound accumulated legal deltas independently of input record admission. */
export {
  AGENT_SESSION_STREAMED_TEXT_MAX_BYTES,
  AGENT_SESSION_STREAMED_TEXT_TOTAL_MAX_BYTES,
  AGENT_SESSION_STREAMED_TEXT_TRUNCATION_MARKER
} from './agent-session-text-prefix'
export const AGENT_SESSION_MAX_STREAMS = 256

export type AgentSessionDeltaSnapshot = {
  text: string
  observedBytes: number
  truncated: boolean
}

export type AgentSessionDeltaCoalescerDeps = {
  /** Emit the complete snapshot, not the increment. */
  emit: (key: string, text: string, snapshot: AgentSessionDeltaSnapshot) => unknown
  /** False skips an accepted snapshot; emit reports actual sink refusal. */
  shouldEmit?: (key: string, textLength: number) => boolean
  checkpointMs?: (key: string) => number | undefined
  windowMs?: number
  maxRetainedBytes?: number
  maxTotalRetainedBytes?: number
  maxStreams?: number
  /** Caller byte-bounds protected metadata; only ordinary streams use the count cap. */
  isProtected?: (key: string) => boolean
  schedule?: (run: () => void, ms: number) => () => void
}

export type AgentSessionDeltaCoalescer = {
  /** False means a retained stream could not flush to admit this key. */
  append: (key: string, delta: string) => boolean
  /** Force also owes a clean snapshot again, for terminal metadata. */
  flush: (key: string, force?: boolean) => boolean
  /** Lifecycle barriers flush every stream first. */
  flushAll: (include?: (key: string) => boolean) => boolean
  /** Authoritative bodies supersede buffered text; drop it without emission. */
  forget: (key: string) => void
  dispose: () => void
  snapshot: (key: string) => AgentSessionDeltaSnapshot | null
  dirty: () => { key: string; snapshot: AgentSessionDeltaSnapshot }[]
  /** External writes satisfy the current snapshot until more text arrives. */
  markFlushed: (key: string) => void
}

function defaultSchedule(run: () => void, ms: number): () => void {
  const timer = setTimeout(run, ms)
  timer.unref?.()
  return () => clearTimeout(timer)
}

export function createAgentSessionDeltaCoalescer(
  deps: AgentSessionDeltaCoalescerDeps
): AgentSessionDeltaCoalescer {
  const windowMs = deps.windowMs ?? AGENT_SESSION_DELTA_COALESCE_MS
  const schedule = deps.schedule ?? defaultSchedule
  const maxRetainedBytes = deps.maxRetainedBytes ?? AGENT_SESSION_STREAMED_TEXT_MAX_BYTES
  const maxTotalRetainedBytes =
    deps.maxTotalRetainedBytes ?? AGENT_SESSION_STREAMED_TEXT_TOTAL_MAX_BYTES
  const maxStreams = Math.max(1, deps.maxStreams ?? AGENT_SESSION_MAX_STREAMS)
  const streams = new Map<
    string,
    {
      chunks: string[]
      retainedBytes: number
      textLength: number
      observedBytes: number
      truncated: boolean
      dirty: boolean
      lastAccepted?: number
    }
  >()
  let totalRetainedBytes = 0
  let cancelTimer: (() => void) | null = null
  let timerAt = Number.POSITIVE_INFINITY
  const evictable = new Set<string>()

  const flushKey = (key: string): boolean => {
    const stream = streams.get(key)
    if (!stream?.dirty) {
      return true
    }
    if (deps.shouldEmit?.(key, stream.textLength) === false) {
      stream.dirty = false
      return true
    }
    const text = stream.chunks.join('')
    const emitted = deps.emit(key, text, {
      text,
      observedBytes: stream.observedBytes,
      truncated: stream.truncated
    })
    if (emitted === false) {
      return false
    }
    stream.dirty = false
    stream.lastAccepted = performance.now()
    return true
  }

  const pendingDelay = (): number => {
    let delay = Number.POSITIVE_INFINITY
    for (const [key, stream] of streams) {
      if (stream.dirty) {
        const interval = deps.checkpointMs?.(key)
        delay = Math.min(
          delay,
          interval !== undefined && stream.lastAccepted !== undefined
            ? stream.lastAccepted + interval > performance.now()
              ? stream.lastAccepted + interval - performance.now()
              : windowMs
            : windowMs
        )
      }
    }
    return delay
  }

  const scheduleFlush = (delay = windowMs): void => {
    if (!Number.isFinite(delay)) {
      return
    }
    if (cancelTimer && timerAt <= performance.now() + delay) {
      return
    }
    cancelTimer?.()
    timerAt = performance.now() + delay
    cancelTimer = schedule(() => {
      cancelTimer = null
      timerAt = Number.POSITIVE_INFINITY
      for (const [key, stream] of streams) {
        const interval = deps.checkpointMs?.(key)
        if (
          interval === undefined ||
          stream.lastAccepted === undefined ||
          performance.now() >= stream.lastAccepted + interval
        ) {
          flushKey(key)
        }
      }
      scheduleFlush(pendingDelay())
    }, delay)
  }

  const flushAll = (include?: (key: string) => boolean): boolean => {
    cancelTimer?.()
    cancelTimer = null
    let emitted = true
    for (const key of streams.keys()) {
      if (!include || include(key)) {
        emitted = flushKey(key) && emitted
      }
    }
    scheduleFlush(pendingDelay())
    return emitted
  }

  return {
    append: (key, delta) => {
      let stream = streams.get(key)
      if (!stream) {
        // Flush before eviction so a new untrusted ID cannot erase observed output.
        while (!deps.isProtected?.(key) && evictable.size >= maxStreams) {
          const oldest = evictable.values().next().value
          if (oldest) {
            if (deps.isProtected?.(oldest)) {
              evictable.delete(oldest)
              continue
            }
            // Backpressure must retain observed text for retry.
            if (!flushKey(oldest)) {
              return false
            }
            const evicted = streams.get(oldest)
            if (evicted) {
              totalRetainedBytes -= evicted.retainedBytes
            }
            streams.delete(oldest)
            evictable.delete(oldest)
          }
          break
        }
        stream = {
          chunks: [],
          retainedBytes: 0,
          textLength: 0,
          observedBytes: 0,
          truncated: false,
          dirty: false
        }
        if (!deps.isProtected?.(key)) {
          evictable.add(key)
        }
      } else if (deps.isProtected?.(key)) {
        evictable.delete(key)
      }
      const deltaBytes = Buffer.byteLength(delta, 'utf8')
      stream.observedBytes += deltaBytes
      if (!stream.truncated) {
        const availableTotal = Math.max(0, maxTotalRetainedBytes - totalRetainedBytes)
        const streamLimit = Math.min(maxRetainedBytes, stream.retainedBytes + availableTotal)
        const next = appendWithinUtf8ByteLimit(
          stream.chunks,
          stream.retainedBytes,
          delta,
          deltaBytes,
          streamLimit
        )
        totalRetainedBytes += next.retainedBytes - stream.retainedBytes
        stream.textLength = next.truncated
          ? (next.chunks[0]?.length ?? 0)
          : stream.textLength + delta.length
        stream.chunks = next.chunks
        stream.retainedBytes = next.retainedBytes
        stream.truncated = next.truncated
        stream.dirty = true
      }
      streams.set(key, stream)
      // Share one timer across streams to bound wakeups per window.
      scheduleFlush()
      return true
    },
    flush: (key, force = false) => {
      const stream = streams.get(key)
      if (stream && force) {
        stream.dirty = true
      }
      const accepted = flushKey(key)
      if (![...streams.values()].some((stream) => stream.dirty)) {
        cancelTimer?.()
        cancelTimer = null
      }
      scheduleFlush(pendingDelay())
      return accepted
    },
    flushAll,
    forget: (key) => {
      const stream = streams.get(key)
      if (stream) {
        totalRetainedBytes -= stream.retainedBytes
        streams.delete(key)
        evictable.delete(key)
      }
      if (![...streams.values()].some((stream) => stream.dirty)) {
        cancelTimer?.()
        cancelTimer = null
      }
    },
    dispose: () => {
      cancelTimer?.()
      cancelTimer = null
      streams.clear()
      evictable.clear()
      totalRetainedBytes = 0
    },
    snapshot: (key) => {
      const stream = streams.get(key)
      return stream
        ? {
            text: stream.chunks.join(''),
            observedBytes: stream.observedBytes,
            truncated: stream.truncated
          }
        : null
    },
    dirty: () =>
      [...streams].flatMap(([key, stream]) =>
        stream.dirty
          ? [
              {
                key,
                snapshot: {
                  text: stream.chunks.join(''),
                  observedBytes: stream.observedBytes,
                  truncated: stream.truncated
                }
              }
            ]
          : []
      ),
    markFlushed: (key) => {
      const stream = streams.get(key)
      if (stream) {
        stream.dirty = false
        stream.lastAccepted = performance.now()
      }
    }
  }
}
