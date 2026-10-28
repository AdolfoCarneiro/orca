import { createForeignSqliteReaderWorker } from '../../foreign-sqlite-readers/foreign-sqlite-reader-spawn'
import { WorkerThreadRequestQueue } from '../../worker-thread-request-queue'
import type {
  JournalTextRowQuery,
  JournalTextValidationRequest,
  JournalTextValidationResponse
} from './journal-text-validation'

const queue = new WorkerThreadRequestQueue<
  JournalTextValidationRequest,
  JournalTextValidationResponse
>({
  factory: () => createForeignSqliteReaderWorker(),
  idleTeardownMs: 30_000,
  maxConsecutiveDeaths: 2,
  awaitRetirement: true,
  queueCap: { maxQueuedCalls: 8, describeFull: () => 'Journal text validator queue is full' },
  createUnavailableError: (message) => new Error(message),
  describeTimeout: (ms) => `Journal text validator timed out after ${ms}ms`,
  describeExit: (code) => `Journal text validator exited with code ${code}`,
  describeCrashLoop: (error) => `Journal text validator crashed repeatedly: ${error}`,
  onUnavailable: (error) => console.warn('[journal-text-prune] validator unavailable:', error)
})

export class JournalTextValidatorUnavailableError extends Error {}

export async function validateJournalTextViaWorker(
  dbPath: string,
  query: JournalTextRowQuery,
  signal: AbortSignal
): Promise<JournalTextValidationResponse> {
  try {
    const response = await queue.dispatch(
      (id) => ({ id, kind: 'journalTextValidation', dbPath, query }),
      30_000,
      signal
    )
    if (!response.ok && response.unavailable) {
      throw new Error(response.error)
    }
    return response
  } catch (error) {
    throw new JournalTextValidatorUnavailableError(String(error))
  }
}
