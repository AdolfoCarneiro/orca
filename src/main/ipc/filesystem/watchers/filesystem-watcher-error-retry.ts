import { isWatcherProcessFailure } from '../watcher-process/parcel-watcher-process-failure'
import type { WaitForLocalWatcherRetry } from './filesystem-watcher-local-capacity'

const WATCHER_ERROR_RETRY_DELAY_MS = 5_000

export function waitForLocalWatcherErrorRetry(retirement: Promise<void>): WaitForLocalWatcherRetry {
  return (retry) => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const arm = (): void => {
      if (!active) {
        return
      }
      timer = setTimeout(() => {
        timer = undefined
        if (active) {
          void retry().catch((error: unknown) => {
            console.error('[filesystem-watcher] error recovery failed:', error)
          })
        }
      }, WATCHER_ERROR_RETRY_DELAY_MS)
      timer.unref()
    }
    void retirement.then(arm, (error: unknown) => {
      if (isWatcherProcessFailure(error) && error.physicalExit) {
        void error.physicalExit.then(arm, () => undefined)
      }
    })
    return () => {
      active = false
      clearTimeout(timer)
    }
  }
}
