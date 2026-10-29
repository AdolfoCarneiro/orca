import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import {
  createTrackedJournalOpener,
  insertTestJournalRow,
  openTestJournalHostDatabase,
  publishTestJournalEpoch
} from './journal-host-database-test-support'
import { applyJournalRow, createJournalReducerState } from './journal-reducer'
import { readJournalSavedState, saveJournalState } from './journal-saved-state'
import type { JournalRow } from './journal-row-schema'
import type { JournalHostDatabase } from './journal-host-database'

const identity: AgentSessionJournalIdentity = {
  sessionId: 'perf-session',
  workspaceId: 'workspace',
  hostId: 'host',
  agent: 'codex',
  providerHandle: codexProviderHandle('thread')
}
const journals = createTrackedJournalOpener()
let root: string
let database: JournalHostDatabase

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-checkpoint-perf-'))
  database = openTestJournalHostDatabase(root)
})
afterEach(async () => {
  vi.restoreAllMocks()
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

it.each([100, 1_000])(
  'does no serialization or item writes for unchanged %i-item checkpoint triggers',
  async (count) => {
    const epoch = 'epoch'
    const state = createJournalReducerState(identity.sessionId, epoch)
    const item = (ordinal: number) =>
      ({ provider: 'codex', threadId: 'thread', turnId: 'turn', ordinal }) as const
    database.transaction((db) => {
      publishTestJournalEpoch(db, identity.sessionId, epoch)
      const first: JournalRow = {
        v: 4,
        epoch,
        seq: 1,
        fence: 1,
        ts: 1,
        kind: 'epoch',
        reason: 'session_created',
        providerHandle: { kind: 'codex', threadId: 'thread' }
      }
      insertTestJournalRow(db, identity.sessionId, first)
      applyJournalRow(state, first)
      for (let index = 0; index < count; index++) {
        const row: JournalRow = {
          v: 4,
          epoch,
          seq: index + 2,
          fence: 1,
          ts: index + 2,
          kind: 'item',
          itemId: agentJournalItemKey(item(index)),
          revision: 1,
          body: {
            kind: 'message',
            role: 'assistant',
            blocks: [{ type: 'text', text: 'x'.repeat(1_024) }]
          }
        }
        insertTestJournalRow(db, identity.sessionId, row)
        applyJournalRow(state, row)
      }
    })
    expect(saveJournalState(database, state)).toBe(true)
    database.db.exec(`CREATE TEMP TABLE checkpoint_write_count (n INTEGER);
    INSERT INTO checkpoint_write_count VALUES (0);
    CREATE TEMP TRIGGER checkpoint_insert AFTER INSERT ON journal_items
      BEGIN UPDATE checkpoint_write_count SET n = n + 1; END;
    CREATE TEMP TRIGGER checkpoint_delete AFTER DELETE ON journal_items
      BEGIN UPDATE checkpoint_write_count SET n = n + 1; END;`)
    const journal = await journals.open({ identity, stateDirectory: root })
    const stringify = vi.spyOn(JSON, 'stringify')
    await journal.checkpoint()
    expect(stringify).not.toHaveBeenCalled()
    expect(database.db.prepare('SELECT n FROM checkpoint_write_count').get()?.n).toBe(0)

    await journal.appendItem(
      item(0),
      {
        kind: 'message',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'changed' }]
      },
      { fence: 1 }
    )
    stringify.mockClear()
    await journal.checkpoint()
    expect(stringify).toHaveBeenCalledTimes(count + 1)
    expect(database.db.prepare('SELECT n FROM checkpoint_write_count').get()?.n).toBe(2 * count)
    expect(readJournalSavedState(database.db, identity.sessionId, epoch)?.lastSequence).toBe(
      count + 2
    )
    stringify.mockClear()
    await journal.close()
    expect(stringify).not.toHaveBeenCalled()
    expect(database.db.prepare('SELECT n FROM checkpoint_write_count').get()?.n).toBe(2 * count)
  }
)
