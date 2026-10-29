import type { ClaudeStreamJsonConnectionHandlers } from './claude-stream-json-connection'

/** Bound a stalled SDK pull after root exit; consumer backpressure retains its own drain wake. */
export const CLAUDE_READER_DRAIN_AFTER_EXIT_MS = 2_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function createClaudeOutputReader(input: {
  session: AsyncIterable<unknown>
  onMessage: ClaudeStreamJsonConnectionHandlers['onMessage']
  onError: (error: unknown) => void
}) {
  let readingBarrier: Promise<void> | null = null
  let releaseReadingBarrier: (() => void) | null = null
  let outputExitProven = false
  let onRootExit: (() => void) | undefined
  let outputError: unknown
  let readingFailure: unknown
  let rejectPull: ((error: unknown) => void) | undefined
  const pauseReading = (): void => {
    if (readingBarrier) {
      return
    }
    readingBarrier = new Promise<void>((resolve) => {
      releaseReadingBarrier = resolve
    })
  }
  const resumeReading = (): void => {
    const release = releaseReadingBarrier
    readingBarrier = null
    releaseReadingBarrier = null
    release?.()
  }
  const waitUntilReadable = (): Promise<void> => readingBarrier ?? Promise.resolve()
  const failOutput = (error: unknown): void => {
    readingFailure = error
    resumeReading()
    rejectPull?.(error)
  }
  const readerDone = (async () => {
    try {
      const iterator = input.session[Symbol.asyncIterator]()
      let completed = false
      try {
        for (;;) {
          await waitUntilReadable()
          if (readingFailure) {
            throw readingFailure
          }
          const next = await new Promise<IteratorResult<unknown>>((resolve, reject) => {
            rejectPull = reject
            let timer: ReturnType<typeof setTimeout> | undefined
            const arm = () => {
              timer ??= setTimeout(
                () => reject(new Error('Claude output did not drain after process exit')),
                CLAUDE_READER_DRAIN_AFTER_EXIT_MS
              )
            }
            onRootExit = arm
            if (outputExitProven) {
              arm()
            }
            iterator
              .next()
              .then(resolve, reject)
              .finally(() => {
                clearTimeout(timer)
                if (onRootExit === arm) {
                  onRootExit = undefined
                }
              })
          })
          rejectPull = undefined
          if (next.done) {
            completed = true
            break
          }
          await waitUntilReadable()
          if (readingFailure) {
            throw readingFailure
          }
          if (!isRecord(next.value)) {
            throw new Error('claude stream-json yielded a non-object message')
          }
          await input.onMessage?.(next.value)
        }
      } finally {
        if (!completed) {
          void iterator.return?.().catch(() => undefined)
        }
      }
    } catch (error: unknown) {
      outputError = error
      input.onError(error)
    }
  })()
  const outputDrained = readerDone.then(() => {
    if (outputError) {
      throw outputError
    }
  })
  void outputDrained.catch(() => undefined)

  return {
    done: readerDone,
    outputDrained,
    pauseReading,
    resumeReading,
    failOutput,
    rootExited: () => {
      outputExitProven = true
      onRootExit?.()
    }
  }
}
