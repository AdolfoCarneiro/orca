import { describe, expect, it, vi } from 'vitest'
import { measureDeltaSnapshotWork } from './agent-session-delta-work-test-support'
import {
  AGENT_SESSION_DELTA_COALESCE_MS,
  createAgentSessionDeltaCoalescer
} from './agent-session-delta-coalescer'

/** Drive scheduling without wall-clock timing. */
function manualClock() {
  const pending: { run: () => void; ms: number }[] = []
  return {
    schedule: (run: () => void, ms: number) => {
      const entry = { run, ms }
      pending.push(entry)
      return () => {
        const index = pending.indexOf(entry)
        if (index !== -1) {
          pending.splice(index, 1)
        }
      }
    },
    fire: () => {
      const due = pending.splice(0)
      for (const entry of due) {
        entry.run()
      }
    },
    windows: () => pending.map((entry) => entry.ms),
    pendingCount: () => pending.length
  }
}

function coalescer(clock: ReturnType<typeof manualClock>, windowMs?: number) {
  const emitted: [string, string][] = []
  const instance = createAgentSessionDeltaCoalescer({
    emit: (key, text) => emitted.push([key, text]),
    schedule: clock.schedule,
    ...(windowMs === undefined ? {} : { windowMs })
  })
  return { instance, emitted }
}

describe('agent-session delta coalescer', () => {
  it('folds a burst into one emit carrying the full text, on one shared window', () => {
    const clock = manualClock()
    const { instance, emitted } = coalescer(clock)

    instance.append('item-1', 'he')
    instance.append('item-1', 'llo')
    instance.append('item-2', 'world')

    expect(emitted).toEqual([])
    expect(clock.windows()).toEqual([AGENT_SESSION_DELTA_COALESCE_MS])

    clock.fire()
    expect(emitted).toEqual([
      ['item-1', 'hello'],
      ['item-2', 'world']
    ])
  })

  it('emits the accumulated snapshot again, not the increment, on the next window', () => {
    const clock = manualClock()
    const { instance, emitted } = coalescer(clock)

    instance.append('item-1', 'he')
    clock.fire()
    instance.append('item-1', 'llo')
    clock.fire()

    expect(emitted).toEqual([
      ['item-1', 'he'],
      ['item-1', 'hello']
    ])
  })

  it('appends ten thousand deltas without rebuilding the retained prefix per token', () => {
    const clock = manualClock()
    const { instance, emitted } = coalescer(clock)

    for (let index = 0; index < 10_000; index += 1) {
      instance.append('item-1', 'x')
    }
    clock.fire()

    expect(emitted).toEqual([['item-1', 'x'.repeat(10_000)]])
  })

  it('does not re-emit a stream with no new text', () => {
    const clock = manualClock()
    const { instance, emitted } = coalescer(clock)

    instance.append('item-1', 'hi')
    clock.fire()
    instance.flushAll()

    expect(emitted).toEqual([['item-1', 'hi']])
  })

  it('flushes pending text ahead of a lifecycle event and cancels the window', () => {
    const clock = manualClock()
    const { instance, emitted } = coalescer(clock)

    instance.append('item-1', 'partial')
    instance.flushAll()

    expect(emitted).toEqual([['item-1', 'partial']])
    expect(clock.pendingCount()).toBe(0)
  })

  it('retains dirty state and surfaces admission failure for retry', () => {
    const clock = manualClock()
    let reject = true
    const emitted: string[] = []
    const instance = createAgentSessionDeltaCoalescer({
      schedule: clock.schedule,
      emit: (_key, text) => {
        if (reject) {
          return false
        }
        emitted.push(text)
        return true
      }
    })

    instance.append('item-1', 'retry me')
    expect(instance.flush('item-1')).toBe(false)
    expect(emitted).toEqual([])
    reject = false
    expect(instance.flush('item-1')).toBe(true)
    expect(emitted).toEqual(['retry me'])
  })

  it('does not evict buffered output when flushing the oldest stream is backpressured', () => {
    const clock = manualClock()
    let reject = true
    const emitted: [string, string][] = []
    const instance = createAgentSessionDeltaCoalescer({
      maxStreams: 1,
      schedule: clock.schedule,
      emit: (key, text) => {
        if (reject) {
          return false
        }
        emitted.push([key, text])
        return true
      }
    })

    instance.append('first', 'preserve me')
    expect(instance.append('second', 'new stream')).toBe(false)
    expect(instance.snapshot('first')?.text).toBe('preserve me')
    reject = false
    expect(instance.append('second', 'new stream')).toBe(true)
    expect(emitted).toEqual([['first', 'preserve me']])
  })

  it('drops a forgotten stream without emitting it, because its final body already landed', () => {
    const clock = manualClock()
    const { instance, emitted } = coalescer(clock)

    instance.append('item-1', 'stale')
    instance.append('item-2', 'kept')
    instance.forget('item-1')
    clock.fire()

    expect(emitted).toEqual([['item-2', 'kept']])
  })

  it('emits nothing after dispose, and leaves no timer behind', () => {
    const clock = manualClock()
    const { instance, emitted } = coalescer(clock)

    instance.append('item-1', 'gone')
    instance.dispose()
    clock.fire()

    expect(emitted).toEqual([])
    expect(clock.pendingCount()).toBe(0)
  })

  it('honours an overridden window', () => {
    const clock = manualClock()
    const { instance } = coalescer(clock, 5)

    instance.append('item-1', 'x')

    expect(clock.windows()).toEqual([5])
  })

  it('bounds retained UTF-8 text while continuing to count observed bytes', () => {
    const clock = manualClock()
    const emitted: { text: string; observedBytes: number; truncated: boolean }[] = []
    const instance = createAgentSessionDeltaCoalescer({
      maxRetainedBytes: 40,
      schedule: clock.schedule,
      emit: (_key, _text, snapshot) => emitted.push(snapshot)
    })

    instance.append('item-1', 'éé')
    instance.append('item-1', `${'é'.repeat(20)}more`)
    clock.fire()
    instance.append('item-1', 'ignored')
    clock.fire()

    expect(emitted).toEqual([
      {
        text: 'ééé\n[Orca: streamed output truncated]',
        observedBytes: 48,
        truncated: true
      }
    ])
    expect(instance.snapshot('item-1')).toEqual({
      text: 'ééé\n[Orca: streamed output truncated]',
      observedBytes: 55,
      truncated: true
    })
  })

  it('bounds aggregate retained stream text across independent items', () => {
    const clock = manualClock()
    const emitted = new Map<string, { text: string; observedBytes: number; truncated: boolean }>()
    const instance = createAgentSessionDeltaCoalescer({
      maxRetainedBytes: 80,
      maxTotalRetainedBytes: 120,
      schedule: clock.schedule,
      emit: (key, _text, snapshot) => emitted.set(key, snapshot)
    })

    instance.append('item-1', 'a'.repeat(80))
    instance.append('item-2', 'b'.repeat(80))
    instance.append('item-3', 'c'.repeat(80))
    clock.fire()
    instance.append('item-3', 'c'.repeat(80))
    clock.fire()

    const snapshots = ['item-1', 'item-2', 'item-3'].map((key) => instance.snapshot(key))
    const retainedBytes = snapshots.reduce(
      (total, snapshot) => total + Buffer.byteLength(snapshot?.text ?? '', 'utf8'),
      0
    )
    expect(retainedBytes).toBeLessThanOrEqual(120)
    expect(snapshots.map((snapshot) => snapshot?.observedBytes)).toEqual([80, 80, 160])
    expect(snapshots.map((snapshot) => snapshot?.truncated)).toEqual([false, true, true])
    expect(emitted.get('item-3')).toEqual({ text: '', observedBytes: 80, truncated: true })
  })
})

describe('snapshot admission before assembly', () => {
  it('reports retained UTF-16 length after Unicode appends and byte truncation', () => {
    const clock = manualClock()
    const shouldEmit = vi.fn(() => true)
    const emitted: [string, string][] = []
    const instance = createAgentSessionDeltaCoalescer({
      schedule: clock.schedule,
      maxRetainedBytes: 40,
      shouldEmit,
      emit: (key, text) => emitted.push([key, text])
    })
    instance.append('unicode', 'éé')
    instance.append('surrogate', '\ud83d')
    instance.append('surrogate', '\ude00')
    clock.fire()
    expect(shouldEmit.mock.calls).toEqual([
      ['unicode', 2],
      ['surrogate', 2]
    ])
    expect(emitted).toEqual([
      ['unicode', 'éé'],
      ['surrogate', '😀']
    ])

    instance.append('unicode', `${'é'.repeat(20)}more`)
    clock.fire()
    const truncated = 'ééé\n[Orca: streamed output truncated]'
    expect(shouldEmit).toHaveBeenLastCalledWith('unicode', truncated.length)
    expect(emitted.at(-1)).toEqual(['unicode', truncated])
    const calls = shouldEmit.mock.calls.length
    instance.append('unicode', 'ignored')
    clock.fire()
    expect(shouldEmit).toHaveBeenCalledTimes(calls)
    instance.dispose()
  })
})

it('keeps per-item deadlines while a newly arriving item gets its first 60 ms window', () => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  try {
    const emitted: [string, number, string][] = []
    const coalescer = createAgentSessionDeltaCoalescer({
      checkpointMs: () => 400,
      emit: (key, text) => emitted.push([key, Date.now(), text])
    })
    coalescer.append('first', 'a')
    vi.advanceTimersByTime(60)
    coalescer.append('first', 'b')
    vi.advanceTimersByTime(130)
    coalescer.append('second', 'x')
    vi.advanceTimersByTime(60)
    expect(emitted).toEqual([
      ['first', 60, 'a'],
      ['second', 250, 'x']
    ])
    vi.advanceTimersByTime(210)
    expect(emitted.at(-1)).toEqual(['first', 460, 'ab'])
    coalescer.append('first', 'forgotten')
    coalescer.forget('first')
    coalescer.append('second', 'disposed')
    coalescer.dispose()
    vi.advanceTimersByTime(1_000)
    expect(emitted).toHaveLength(3)
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

it('delivers the owed tail after 400 elapsed ms despite a backward wall-clock step', () => {
  vi.useFakeTimers()
  vi.setSystemTime(300_000)
  const emitted: string[] = []
  const coalescer = createAgentSessionDeltaCoalescer({
    checkpointMs: () => 400,
    emit: (_key, text) => emitted.push(text)
  })
  try {
    coalescer.append('reply', 'first')
    vi.advanceTimersByTime(60)
    expect(emitted).toEqual(['first'])
    vi.setSystemTime(0)
    coalescer.append('reply', ' tail')
    vi.advanceTimersByTime(399)
    expect(emitted).toEqual(['first'])
    vi.advanceTimersByTime(1)
    expect(emitted).toEqual(['first', 'first tail'])
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    coalescer.dispose()
    vi.useRealTimers()
  }
})

it('retains a forced terminal snapshot on refusal even when the capped stream was clean', () => {
  const clock = manualClock()
  const emitted: string[] = []
  let refuse = false
  const coalescer = createAgentSessionDeltaCoalescer({
    maxRetainedBytes: 40,
    schedule: clock.schedule,
    emit: (_key, text) => {
      if (refuse) {
        return false
      }
      emitted.push(text)
      return true
    }
  })
  coalescer.append('reply', 'x'.repeat(100))
  clock.fire()
  refuse = true
  expect(coalescer.flush('reply', true)).toBe(false)
  expect(clock.pendingCount()).toBe(1)
  refuse = false
  clock.fire()
  expect(emitted).toEqual([coalescer.snapshot('reply')?.text, coalescer.snapshot('reply')?.text])
  expect(clock.pendingCount()).toBe(0)
  coalescer.dispose()
})

it('keeps all-dirty force, refused full flush, scheduled recovery and selected removal linear', () => {
  vi.useFakeTimers()
  try {
    for (const n of [10, 100]) {
      let refuse = false
      const outputs: string[] = []
      const c = createAgentSessionDeltaCoalescer({
        checkpointMs: () => 400,
        emit: (key, text) => {
          if (refuse) {
            return false
          }
          outputs.push(`${key}:${text}`)
          return true
        }
      })
      for (let i = 0; i < n; i++) {
        c.append(`m${i}`, 'P')
      }
      c.flushAll()
      refuse = true
      const meter = measureDeltaSnapshotWork()
      for (let i = 0; i < n; i++) {
        expect(c.flush(`m${i}`, true)).toBe(false)
      }
      expect(meter.work()).toBeLessThanOrEqual(3 * n)
      meter.reset()
      expect(vi.getTimerCount()).toBe(1)
      vi.advanceTimersByTime(60)
      expect(outputs).toHaveLength(n)
      expect(meter.work()).toBeLessThanOrEqual(3 * n)
      refuse = false
      vi.advanceTimersByTime(340)
      expect(outputs).toHaveLength(2 * n)
      expect(vi.getTimerCount()).toBe(0)
      for (let i = 0; i < n; i++) {
        c.append(`m${i}`, ' tail')
      }
      refuse = true
      meter.reset()
      expect(c.flushAll()).toBe(false)
      expect(meter.work()).toBeLessThanOrEqual(4 * n)
      expect(vi.getTimerCount()).toBe(1)
      refuse = false
      vi.advanceTimersByTime(400)
      for (let i = 0; i < n; i++) {
        expect(outputs.filter((text) => text === `m${i}:P tail`)).toHaveLength(1)
      }
      meter.reset()
      for (let i = 0; i < n; i++) {
        c.forget(`m${i}`)
      }
      expect(meter.work()).toBeLessThanOrEqual(2 * n)
      meter.stop()
      expect(vi.getTimerCount()).toBe(0)
      c.dispose()
    }
  } finally {
    vi.restoreAllMocks()
    vi.useRealTimers()
  }
})

it('distinguishes intentional skips from refusal and tolerates accepted callback retirement across eviction and reentry', () => {
  const clock = manualClock()
  let eligible = false
  let refuse = false
  const outputs: string[] = []
  const c = createAgentSessionDeltaCoalescer({
    maxStreams: 1,
    schedule: clock.schedule,
    shouldEmit: () => eligible,
    emit: (key, text) => {
      if (refuse) {
        return false
      }
      outputs.push(`${key}:${text}`)
      c.markFlushed(key)
      c.markFlushed(key)
      if (text === 'retire') {
        c.forget(key)
      }
      return true
    }
  })
  c.append('a', 'P')
  clock.fire()
  expect(clock.pendingCount()).toBe(0)
  expect(outputs).toEqual([])
  expect(c.snapshot('a')?.text).toBe('P')
  eligible = true
  c.append('a', ' tail')
  refuse = true
  expect(c.append('b', 'B')).toBe(false)
  expect(clock.windows().every((ms) => ms > 0)).toBe(true)
  refuse = false
  clock.fire()
  expect(outputs).toEqual(['a:P tail'])
  expect(c.append('b', 'B')).toBe(true)
  expect(c.snapshot('a')).toBeNull()
  clock.fire()
  c.forget('b')
  c.append('a', 'retire')
  clock.fire()
  expect(c.snapshot('a')).toBeNull()
  c.append('a', 'new')
  clock.fire()
  expect(outputs).toEqual(['a:P tail', 'b:B', 'a:retire', 'a:new'])
  c.dispose()
  expect(clock.pendingCount()).toBe(0)
})
