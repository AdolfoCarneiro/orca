export type CheckoutProbeFailure = {
  count: number
  retryAfter: number
  now: () => number
}

type RetirementSweep = {
  entries: MapIterator<[string, CheckoutProbeFailure]>
  remaining: number
  generation: number
}

const RETIREMENT_BATCH_SIZE = 64

export class WslCheckoutProbeFailureRetirement {
  private timer: ReturnType<typeof setTimeout> | undefined
  private continuation: ReturnType<typeof setImmediate> | undefined
  private sweep: RetirementSweep | undefined
  private generation = 0

  constructor(
    private readonly failures: Map<string, CheckoutProbeFailure>,
    private readonly pending: ReadonlyMap<string, Promise<void>>,
    private readonly graceMs: number
  ) {}

  schedule(): void {
    if (this.timer || this.sweep || this.failures.size === 0) {
      return
    }
    const generation = this.generation
    this.timer = setTimeout(() => {
      if (generation !== this.generation) {
        return
      }
      this.timer = undefined
      this.sweep = {
        entries: this.failures.entries(),
        remaining: this.failures.size,
        generation
      }
      this.retireBatch(this.sweep)
    }, this.graceMs)
    this.timer.unref?.()
  }

  stopIfEmpty(): void {
    if (this.failures.size === 0) {
      this.reset()
    }
  }

  reset(): void {
    this.generation += 1
    clearTimeout(this.timer)
    clearImmediate(this.continuation)
    this.timer = undefined
    this.continuation = undefined
    this.sweep = undefined
  }

  private retireBatch(sweep: RetirementSweep): void {
    if (sweep.generation !== this.generation) {
      return
    }
    for (let visited = 0; visited < RETIREMENT_BATCH_SIZE && sweep.remaining > 0; visited += 1) {
      const entry = sweep.entries.next()
      if (entry.done) {
        sweep.remaining = 0
        break
      }
      sweep.remaining -= 1
      const [key, failure] = entry.value
      const expired = !this.pending.has(key) && failure.now() >= failure.retryAfter + this.graceMs
      if (sweep.generation !== this.generation) {
        return
      }
      if (expired) {
        this.failures.delete(key)
      }
    }
    if (this.failures.size === 0) {
      this.reset()
    } else if (sweep.remaining > 0) {
      this.continuation = setImmediate(() => {
        if (sweep.generation !== this.generation) {
          return
        }
        this.continuation = undefined
        this.retireBatch(sweep)
      })
      this.continuation.unref?.()
    } else {
      this.sweep = undefined
      this.schedule()
    }
  }
}
