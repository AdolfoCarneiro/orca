import {
  COMPACTION_IDENTITY,
  COMPACTION_ROWS
} from '../../../shared/journal-compaction-frames.test-fixture'
import type { TrackedJournalOpener } from './journal-host-database-test-support'
import {
  insertTestJournalRow,
  openTestJournalHostDatabase,
  publishTestJournalEpoch
} from './journal-host-database-test-support'
import { backfillJournalState } from './journal-state-backfill'

export async function openCompactionConsumerJournal(journals: TrackedJournalOpener, root: string) {
  const database = openTestJournalHostDatabase(root)
  database.transaction((db) => {
    publishTestJournalEpoch(db, COMPACTION_IDENTITY.sessionId, COMPACTION_ROWS[0]!.epoch)
    for (const row of COMPACTION_ROWS) insertTestJournalRow(db, COMPACTION_IDENTITY.sessionId, row)
  })
  let journal = await journals.open({
    identity: COMPACTION_IDENTITY,
    stateDirectory: root,
    now: () => 2000
  })
  return {
    get journal() {
      return journal
    },
    retireAndReopen: async () => {
      let clock = 0
      const result = await backfillJournalState({
        database: () => database,
        checkpointOpen: async (sessionId) => {
          if (sessionId !== journal.identity.sessionId) return false
          await journal.checkpoint()
          return true
        },
        stopped: () => false,
        now: () => (clock += 30),
        rest: async () => {
          if (database.db.isTransaction)
            throw new Error('maintenance rested with a transaction open')
        }
      })
      if (!result || result.deleted !== 3)
        throw new Error(`expected three real retirements: ${JSON.stringify(result)}`)
      await journals.closeAll()
      journal = await journals.open({
        identity: COMPACTION_IDENTITY,
        stateDirectory: root,
        now: () => 2000
      })
      return journal
    }
  }
}
