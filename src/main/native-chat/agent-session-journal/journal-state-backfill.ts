// Pace closed-chat replay between pages; live chats checkpoint through their own write queue.

import type { JournalHostDatabase } from './journal-host-database'
import { compactJournalSession, reclaimJournalPages } from './journal-compaction'
import { startJournalRowFold } from './journal-open'
import { createJournalReducerState } from './journal-reducer'
import { readJournalRowsAfter } from './journal-row-table'
import {
  logJournalCheckpointFailure,
  readJournalSavedState,
  saveJournalState,
  sweepJournalSavedState,
  unrefJournalCheckpointTimer
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

export async function backfillJournalState(
  run: JournalStateBackfillRun
): Promise<{ deleted: number } | null> {
  const now = run.now ?? Date.now
  const rest =
    run.rest ??
    ((ms) => new Promise<void>((resolve) => unrefJournalCheckpointTimer(setTimeout(resolve, ms))))
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
    return null
  }
  sweepJournalSavedState(database)
  const sessions = database.db
    .prepare(`SELECT s.session_id, s.epoch,
      (SELECT MAX(r.seq) FROM journal_rows r
        WHERE r.session_id = s.session_id AND r.epoch = s.epoch) AS last_seq
    FROM journal_sessions s ORDER BY s.session_id`)
    .all()
  let deleted = 0
  let failed = false
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
        return null
      }
      const checkpointed = await run.checkpointOpen(sessionId)
      const opened = current()
      if (!opened) {
        return null
      }
      const state =
        readJournalSavedState(opened.db, sessionId, epoch) ??
        createJournalReducerState(sessionId, epoch)
      const fold = startJournalRowFold({ sessionId, epoch }, state)
      let afterSequence = state.lastSequence === 0 ? Number.MIN_SAFE_INTEGER : state.lastSequence
      while (!checkpointed && afterSequence < lastSequence) {
        const next = await pace()
        if (!next) {
          return null
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
        return null
      }
      if (
        !checkpointed &&
        !loaded.damage &&
        !loaded.newer &&
        loaded.state.lastSequence === lastSequence
      ) {
        // Opening meanwhile is safe: publication can only advance the same immutable prefix.
        if (!(await run.checkpointOpen(sessionId))) {
          await new JournalWriteQueue(sessionId).serialize(() =>
            saveJournalState(target, loaded.state)
          )
        }
      }
    } catch (error) {
      failed = true
      logJournalCheckpointFailure(sessionId, error)
    }
    const target = await pace()
    if (!target) {
      return null
    }
    const through = target.db
      .prepare('SELECT through_seq FROM journal_state WHERE session_id = ? AND epoch = ?')
      .get(sessionId, epoch)?.through_seq
    failed ||= typeof through !== 'number' || through < lastSequence
    // Deletion failures escape the checkpoint catch and still get the scheduler's later wake.
    const removed = await compactJournalSession(target, sessionId, epoch, pace)
    if (removed === null) {
      return null
    }
    deleted += removed
  }
  return (await reclaimJournalPages(pace)) && !failed ? { deleted } : null
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
    unrefJournalCheckpointTimer(timer)
  }
  schedule(60 * 1_000)
  return {
    stop: () => {
      stopped = true
      clearTimeout(timer)
    }
  }
}
