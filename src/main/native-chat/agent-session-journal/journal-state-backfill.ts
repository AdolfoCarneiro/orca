// Pace closed-chat replay between pages; live chats checkpoint through their own write queue.

import type { JournalHostDatabase } from './journal-host-database'
import { startJournalRowFold } from './journal-open'
import { createJournalReducerState } from './journal-reducer'
import { readJournalRowsAfter } from './journal-row-table'
import {
  logJournalCheckpointFailure,
  readJournalSavedState,
  saveJournalState,
  sweepJournalSavedState
} from './journal-saved-state'
import { JournalWriteQueue } from './journal-write-queue'

export type JournalStateBackfillRun = {
  database: () => JournalHostDatabase | null
  checkpointOpen: (sessionId: string) => Promise<boolean>
  stopped: () => boolean
  now?: () => number
  rest?: (ms: number) => Promise<void>
}

const PAGE_ROWS = 32
const SLICE_MS = 25

export async function backfillJournalState(run: JournalStateBackfillRun): Promise<void> {
  const now = run.now ?? Date.now
  const rest =
    run.rest ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.()))
  let sliceAt = now()
  const current = (): JournalHostDatabase | null => {
    const database = run.database()
    return run.stopped() || !database || database.isClosed || database.readOnly ? null : database
  }
  const pace = async (): Promise<JournalHostDatabase | null> => {
    const elapsed = now() - sliceAt
    if (elapsed >= SLICE_MS) {
      await rest(elapsed * 9)
      sliceAt = now()
    }
    return current()
  }
  const database = current()
  if (!database) {
    return
  }
  sweepJournalSavedState(database)
  const sessions = database.db
    .prepare(`SELECT s.session_id, s.epoch,
      (SELECT MAX(r.seq) FROM journal_rows r
        WHERE r.session_id = s.session_id AND r.epoch = s.epoch) AS last_seq
    FROM journal_sessions s
    LEFT JOIN journal_state c ON c.session_id = s.session_id AND c.epoch = s.epoch
    WHERE c.through_seq IS NULL OR c.through_seq < (
      SELECT MAX(r.seq) FROM journal_rows r
        WHERE r.session_id = s.session_id AND r.epoch = s.epoch
    ) ORDER BY s.session_id`)
    .all()
  for (const session of sessions) {
    const { session_id: sessionId, epoch, last_seq: lastSequence } = session
    if (
      typeof sessionId !== 'string' ||
      typeof epoch !== 'string' ||
      typeof lastSequence !== 'number'
    ) {
      continue
    }
    try {
      if (!(await pace())) {
        return
      }
      if (await run.checkpointOpen(sessionId)) {
        continue
      }
      const opened = current()
      if (!opened) {
        return
      }
      const state =
        readJournalSavedState(opened.db, sessionId, epoch) ??
        createJournalReducerState(sessionId, epoch)
      const fold = startJournalRowFold({ sessionId, epoch }, state)
      let afterSequence = state.lastSequence === 0 ? Number.MIN_SAFE_INTEGER : state.lastSequence
      while (afterSequence < lastSequence) {
        const next = await pace()
        if (!next) {
          return
        }
        const page = readJournalRowsAfter(
          next.db,
          sessionId,
          epoch,
          afterSequence,
          PAGE_ROWS
        ).filter((entry) => entry.seq <= lastSequence)
        if (page.length === 0) {
          break
        }
        let readable = true
        for (const entry of page) {
          afterSequence = entry.seq
          if (!fold.add(entry)) {
            readable = false
            break
          }
        }
        if (!readable) {
          break
        }
      }
      const loaded = fold.finish()
      const target = await pace()
      if (!target) {
        return
      }
      if (!loaded.damage && !loaded.newer && loaded.state.lastSequence === lastSequence) {
        // Opening meanwhile is safe: publication can only advance the same immutable prefix.
        if (!(await run.checkpointOpen(sessionId))) {
          await new JournalWriteQueue(sessionId).serialize(() =>
            saveJournalState(target, loaded.state)
          )
        }
      }
    } catch (error) {
      logJournalCheckpointFailure(sessionId, error)
    }
  }
}

export function startJournalStateBackfill(
  run: Omit<JournalStateBackfillRun, 'stopped'>,
  onError: (error: unknown) => void
): { stop: () => void } {
  let stopped = false
  let timer: ReturnType<typeof setTimeout>
  const schedule = (delay: number): void => {
    timer = setTimeout(() => {
      void backfillJournalState({ ...run, stopped: () => stopped })
        .catch(onError)
        .finally(() => {
          if (!stopped) {
            schedule(6 * 60 * 60 * 1_000)
          }
        })
    }, delay)
    timer.unref?.()
  }
  schedule(60 * 1_000)
  return {
    stop: () => {
      stopped = true
      clearTimeout(timer)
    }
  }
}
