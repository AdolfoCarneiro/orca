import { remainingFilesystemHostBudget } from './filesystem-host-deadline'
import { FilesystemHostSupervisorError } from './filesystem-host-supervisor-error'

type QueuedTask = {
  key: string | null
  run: () => Promise<void>
  timer?: ReturnType<typeof setTimeout>
  reject: (error: unknown) => void
}

export class FilesystemHostBackgroundQueue {
  private active = 0
  private disposed = false
  private readonly pending: QueuedTask[] = []

  constructor(private readonly maximumConcurrent: number) {
    if (!Number.isInteger(maximumConcurrent) || maximumConcurrent < 1) {
      throw new Error('Filesystem host background concurrency must be positive')
    }
  }

  run<T>(
    task: (remainingMs: number) => Promise<T>,
    key: string | null = null,
    expiresAt = Infinity
  ): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new Error('Filesystem host background queue is disposed'))
    }
    if (this.pending.length >= 128) {
      return Promise.reject(new Error('Filesystem host background queue is full'))
    }
    return new Promise<T>((resolve, reject) => {
      const queued: QueuedTask = {
        key,
        run: async () => {
          try {
            resolve(await task(remainingFilesystemHostBudget(expiresAt)))
          } catch (error) {
            reject(error)
          }
        },
        reject
      }
      if (Number.isFinite(expiresAt)) {
        queued.timer = setTimeout(
          () => {
            const index = this.pending.indexOf(queued)
            if (index !== -1) {
              this.pending.splice(index, 1)
              reject(
                new FilesystemHostSupervisorError('deadline', 'Filesystem host admission expired')
              )
            }
          },
          Math.max(0, expiresAt - Date.now())
        )
      }
      this.pending.push(queued)
      this.pump()
    })
  }

  cancel(key: string): boolean {
    return this.cancelMany(new Set([key])).length > 0
  }

  cancelMany(keys: ReadonlySet<string>): string[] {
    const retained: QueuedTask[] = []
    const cancelled = new Set<string>()
    for (const task of this.pending.splice(0)) {
      if (task.key !== null && keys.has(task.key)) {
        cancelled.add(task.key)
        clearTimeout(task.timer)
        task.reject(new Error('Filesystem host background task was cancelled'))
      } else {
        retained.push(task)
      }
    }
    this.pending.push(...retained)
    return [...cancelled]
  }

  dispose(): void {
    this.disposed = true
    const error = new Error('Filesystem host background queue is disposed')
    for (const task of this.pending.splice(0)) {
      clearTimeout(task.timer)
      task.reject(error)
    }
  }

  private pump(): void {
    while (!this.disposed && this.active < this.maximumConcurrent) {
      const task = this.pending.shift()
      if (!task) {
        return
      }
      clearTimeout(task.timer)
      this.active++
      void task.run().finally(() => {
        this.active--
        this.pump()
      })
    }
  }
}
