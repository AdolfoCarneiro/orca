import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  WslCheckoutProbeFailureRetirement,
  type CheckoutProbeFailure
} from './wsl-windows-checkout-probe-retirement'

const GRACE_MS = 10 * 60_000

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('WslCheckoutProbeFailureRetirement', () => {
  it('uses each originating clock and retains active debt across a rollback', async () => {
    const failures = new Map<string, CheckoutProbeFailure>()
    const retirement = new WslCheckoutProbeFailureRetirement(failures, new Map(), GRACE_MS)
    let firstNow = 10_000
    let secondNow = 20_000
    failures.set('first', { count: 1, retryAfter: 40_000, now: () => firstNow })
    failures.set('second', { count: 1, retryAfter: 50_000, now: () => secondNow })
    retirement.schedule()

    firstNow -= 100_000
    await vi.advanceTimersByTimeAsync(GRACE_MS)
    expect(failures.size).toBe(2)
    firstNow = 40_000 + GRACE_MS
    await vi.advanceTimersByTimeAsync(GRACE_MS)
    expect([...failures.keys()]).toEqual(['second'])
    secondNow = 50_000 + GRACE_MS
    await vi.advanceTimersByTimeAsync(GRACE_MS)
    expect(failures.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retains history for a pending retry and stops immediately after success', async () => {
    const failures = new Map<string, CheckoutProbeFailure>([
      ['held', { count: 2, retryAfter: 60_000, now: () => 60_000 + GRACE_MS }]
    ])
    const pending = new Map<string, Promise<void>>([['held', Promise.resolve()]])
    const retirement = new WslCheckoutProbeFailureRetirement(failures, pending, GRACE_MS)
    retirement.schedule()
    await vi.advanceTimersByTimeAsync(GRACE_MS)
    expect(failures.get('held')?.count).toBe(2)
    expect(vi.getTimerCount()).toBe(1)

    pending.delete('held')
    failures.delete('held')
    retirement.stopIfEmpty()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds each slice and finishes its initial population despite new inserts', async () => {
    const failures = new Map<string, CheckoutProbeFailure>()
    const freshNow = vi.fn(() => 0)
    const expiredNow = vi.fn(() => {
      failures.set(`new-${expiredNow.mock.calls.length}`, {
        count: 1,
        retryAfter: 30_000,
        now: freshNow
      })
      return GRACE_MS
    })
    for (let index = 0; index < 200; index += 1) {
      failures.set(`old-${index}`, { count: 1, retryAfter: 0, now: expiredNow })
    }
    const retirement = new WslCheckoutProbeFailureRetirement(failures, new Map(), GRACE_MS)
    retirement.schedule()

    await vi.advanceTimersByTimeAsync(GRACE_MS)
    expect(expiredNow).toHaveBeenCalledTimes(64)
    await vi.advanceTimersByTimeAsync(10)
    expect(expiredNow).toHaveBeenCalledTimes(200)
    expect(freshNow).not.toHaveBeenCalled()
    expect(failures.size).toBe(200)
    expect(vi.getTimerCount()).toBe(1)
    retirement.reset()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels an unfinished generation before a replacement is scheduled', async () => {
    const failures = new Map<string, CheckoutProbeFailure>()
    const oldNow = vi.fn(() => 0)
    for (let index = 0; index < 100; index += 1) {
      failures.set(`old-${index}`, { count: 1, retryAfter: 30_000, now: oldNow })
    }
    const retirement = new WslCheckoutProbeFailureRetirement(failures, new Map(), GRACE_MS)
    retirement.schedule()
    await vi.advanceTimersByTimeAsync(GRACE_MS)
    expect(oldNow).toHaveBeenCalledTimes(64)

    retirement.reset()
    failures.clear()
    expect(vi.getTimerCount()).toBe(0)
    failures.set('new', { count: 1, retryAfter: 30_000, now: () => 30_000 + GRACE_MS })
    retirement.schedule()
    await vi.advanceTimersByTimeAsync(10)
    expect(oldNow).toHaveBeenCalledTimes(64)
    expect(failures.has('new')).toBe(true)
    await vi.advanceTimersByTimeAsync(GRACE_MS)
    expect(failures.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
