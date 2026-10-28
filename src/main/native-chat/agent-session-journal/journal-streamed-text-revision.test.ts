import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { codexImageItemBody } from '../../codex/codex-image-item-translation'
import { liveTestJournalRows } from './journal-host-database-test-support'
import { parseJournalRow } from './journal-row-schema'
import { journalPragmaNumber } from './journal-database'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from './journal-host-database-test-support'
import { openAgentSessionJournal } from './journal-store-factory'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-streamed-revision-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

const text = (
  role: 'assistant' | 'user' | 'reasoning',
  value: string
): AgentJournalMessageItem => ({
  kind: 'message',
  role,
  blocks: [{ type: 'text', text: value }]
})

it('keeps image and goal transitions FULL, streams text at NORMAL, and restores FULL', async () => {
  const database = openTestJournalHostDatabase(root)
  const levels: number[] = []
  database.transaction((db) => levels.push(journalPragmaNumber(db, 'synchronous')), true)
  levels.push(journalPragmaNumber(database.db, 'synchronous'))
  database.transaction((db) => levels.push(journalPragmaNumber(db, 'synchronous')))
  expect(() =>
    database.transaction(() => {
      throw new Error('rolled back')
    }, true)
  ).toThrow('rolled back')
  levels.push(journalPragmaNumber(database.db, 'synchronous'))
  expect(levels).toEqual([1, 2, 2, 2])
  const journal = await openAgentSessionJournal({
    database,
    identity: {
      sessionId: 'chat',
      workspaceId: 'workspace',
      hostId: 'host',
      agent: 'codex',
      providerHandle: null
    }
  })
  levels.length = 0
  const exec = database.db.exec.bind(database.db)
  vi.spyOn(database.db, 'exec').mockImplementation((sql) => {
    if (sql === 'COMMIT') {
      levels.push(journalPragmaNumber(database.db, 'synchronous'))
    }
    exec(sql)
  })
  const image = { id: 'image', type: 'imageGeneration' }
  for (const body of [
    text('assistant', 'Generating image'),
    codexImageItemBody({ ...image, status: 'inProgress' }),
    codexImageItemBody({ ...image, status: 'completed', result: 'AAAA' }),
    text('assistant', 'Image preview unavailable'),
    { ...text('assistant', 'Goal'), sentAs: 'goal' as const },
    text('assistant', 'Goal reached'),
    { ...text('reasoning', 'Thinking'), state: 'running' as const },
    { ...text('reasoning', 'Thinking more'), state: 'running' as const },
    { ...text('reasoning', 'Done thinking'), state: 'completed' as const, completedAt: 100 },
    text('assistant', 'Answer')
  ]) {
    await journal.appendItem(
      { provider: 'codex', threadId: 'thread', turnId: 'turn', ordinal: 1 },
      body,
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  }
  expect(levels).toEqual([2, 1, 2, 2, 2, 2, 2, 1, 2, 2])
  expect(journalPragmaNumber(database.db, 'synchronous')).toBe(2)
  await journal.close()
})

it('retains one full text copy and replays its original position and annotations after reopen', async () => {
  const database = openTestJournalHostDatabase(root)
  const options = {
    database,
    identity: {
      sessionId: 'retention',
      workspaceId: 'workspace',
      hostId: 'host',
      agent: 'codex' as const,
      providerHandle: null
    }
  }
  const journal = await openAgentSessionJournal(options)
  const identity = { provider: 'codex' as const, threadId: 'thread', turnId: 'turn', ordinal: 1 }
  let original = ''
  for (let index = 1; index <= 100; index += 1) {
    await journal.appendItem(identity, text('assistant', 'x'.repeat(index * 4096)), {
      fence: 1,
      ownerFence: 1,
      executionOwner: 1,
      observedAt: index,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE,
      agentId: 'child',
      providerParentRef: 'parent'
    })
    if (index === 1) {
      original = liveTestJournalRows(database.db, 'retention').at(-1)!.rowJson
    }
  }
  const final = text('assistant', `${'x'.repeat(100 * 4096)} final`)
  await journal.appendItem(identity, final, { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE })
  const snapshot = journal.snapshot().items
  const saved = liveTestJournalRows(database.db, 'retention')
  const rows = saved.map((entry) => parseJournalRow(entry.rowJson))
  expect(rows.every((row) => row.ok)).toBe(true)
  const originalRow = JSON.parse(original)
  originalRow.body.blocks[0].text = ''
  expect(JSON.parse(saved[1].rowJson)).toEqual(originalRow)
  const storedBytes = saved.reduce((bytes, row) => bytes + Buffer.byteLength(row.rowJson), 0)
  expect(storedBytes).toBeLessThan(Buffer.byteLength(JSON.stringify(final)) * 1.3)
  expect(snapshot[0]).toMatchObject({
    sequence: 2,
    observedAt: 1,
    turnScope: AGENT_JOURNAL_THREAD_SCOPE,
    body: final
  })
  await journal.close()
  const reopened = await openAgentSessionJournal(options)
  expect(reopened.snapshot().items).toEqual(snapshot)
  await reopened.close()
})
