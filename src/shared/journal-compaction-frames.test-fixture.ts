// The SQLite producer test verifies these shared transport frames before client wrappers consume them.
import { agentJournalItemKey } from './agent-session-journal-item-key'
import { agentSessionSendBodyFingerprint } from './structured-agent-session-send-mutation'
import type {
  AgentJournalMessageItem,
  AgentSessionJournalIdentity
} from './agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from './agent-session-wire'
import { codexProviderHandle } from './agent-session-provider-handle-encoding'
import {
  applyJournalRow,
  createJournalReducerState
} from '../main/native-chat/agent-session-journal/journal-reducer'
import { readJournalPublicView } from '../main/native-chat/agent-session-journal/journal-public-read'
import type { JournalRow } from '../main/native-chat/agent-session-journal/journal-row-schema'
import type { AgentSessionJournal } from '../main/native-chat/agent-session-journal/journal-store'
import {
  readAgentSessionHistory,
  readAgentSessionHydrationPage
} from '../main/native-chat/agent-session-wire/agent-session-history-page'

export const COMPACTION_IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'folder-workspace',
  hostId: 'local',
  agent: 'codex',
  providerHandle: codexProviderHandle('thread-1')
}
export const COMPACTION_EPOCH = 'epoch-1'
const user: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'Please investigate' }]
}
const said = (text: string) => ({
  kind: 'message' as const,
  role: 'assistant' as const,
  blocks: [{ type: 'text' as const, text }]
})
const row = (seq: number) => ({ v: 4, epoch: COMPACTION_EPOCH, seq, fence: 1, ts: 1000 + seq })
const reply = (seq: number, revision: number): JournalRow => ({
  ...row(seq),
  kind: 'item',
  itemId: 'reply',
  revision,
  body: said(`answer ${revision}`)
})
export const COMPACTION_ROWS: readonly JournalRow[] = [
  {
    ...row(1),
    kind: 'epoch',
    reason: 'legacy_import',
    providerHandle: { kind: 'codex', threadId: 'thread-1' }
  },
  {
    ...row(2),
    kind: 'submission',
    clientMessageId: 'send',
    payloadFingerprint: agentSessionSendBodyFingerprint(COMPACTION_IDENTITY.sessionId, user),
    body: user,
    providerHandle: { kind: 'codex', threadId: 'thread-1' },
    handoverRecorded: true
  },
  {
    ...row(3),
    kind: 'dispatch',
    clientMessageId: 'send',
    state: 'pending',
    providerItemId: null,
    reason: null
  },
  {
    ...row(4),
    kind: 'item',
    itemId: agentJournalItemKey({
      provider: 'codex',
      threadId: 'thread-1',
      turnId: 'turn',
      ordinal: 0
    }),
    revision: 1,
    body: user
  },
  {
    ...row(5),
    kind: 'item',
    itemId: 'turn',
    revision: 1,
    body: { kind: 'turn', turnId: 'turn', state: 'running' }
  },
  reply(6, 1),
  { ...row(7), kind: 'item', itemId: 'removed', revision: 1, body: said('removed') },
  {
    ...row(8),
    kind: 'item',
    itemId: 'reply',
    revision: 2,
    body: said('answer 2'),
    executionOwner: 1
  },
  {
    ...row(9),
    kind: 'lifecycle-batch',
    settlementId: 'shared',
    mutations: [
      { kind: 'item', itemId: 'reply', revision: 3, body: said('answer 3') },
      {
        kind: 'item',
        itemId: 'child',
        revision: 1,
        body: said('child answer'),
        agentId: 'child',
        producerKind: 'agent'
      }
    ]
  },
  reply(10, 4),
  {
    ...row(11),
    kind: 'lifecycle-batch',
    settlementId: 'remove',
    mutations: [{ kind: 'tombstone', itemId: 'removed', revision: 2 }]
  },
  { ...row(12), kind: 'item', itemId: 'removed', revision: 1, body: said('stale removed') },
  reply(13, 1),
  {
    ...row(14),
    kind: 'queue',
    messageId: 'draft',
    change: {
      op: 'queued',
      body: user,
      position: 1,
      queuedAt: { epoch: COMPACTION_EPOCH, sequence: 14 }
    }
  },
  {
    ...row(15),
    kind: 'item',
    itemId: 'prompt',
    revision: 1,
    body: { kind: 'approval', title: 'Run it?', detail: null, resolution: { state: 'pending' } }
  }
]
export const COMPACTION_RETAINED_SEQUENCES = [1, 2, 3, 4, 5, 6, 7, 9, 12, 13, 14, 15]

export function compactionTransportCorpus(through = 15) {
  const state = createJournalReducerState(COMPACTION_IDENTITY.sessionId, COMPACTION_EPOCH)
  for (const entry of COMPACTION_ROWS)
    if (entry.seq <= through) applyJournalRow(state, entry, entry.ts)
  const view = readJournalPublicView(state)
  const journal = {
    isReadOnly: false,
    snapshot: () => view.snapshot,
    publicRead: () => view,
    cursor: () => view.snapshot.cursor,
    canonicalItemId: (id: string) => state.aliases.get(id) ?? id,
    readSince: (cursor: { sequence: number }, limit?: number) => ({
      ok: true as const,
      cursor: view.snapshot.cursor,
      rows: COMPACTION_ROWS.filter(
        (entry) =>
          COMPACTION_RETAINED_SEQUENCES.includes(entry.seq) &&
          entry.seq > cursor.sequence &&
          entry.seq <= through
      ).slice(0, limit)
    })
  }
  // SAFETY: these production history readers use exactly the snapshot/cursor/read members above.
  const reader = journal as unknown as AgentSessionJournal
  const snapshot: AgentSessionSubscribeEvent = {
    type: 'snapshot',
    sessionId: COMPACTION_IDENTITY.sessionId,
    page: readAgentSessionHydrationPage(reader, 1),
    fence: 1,
    hostNow: 0
  }
  const result = readAgentSessionHistory(reader, {
    sessionId: COMPACTION_IDENTITY.sessionId,
    direction: 'after',
    cursor: { epoch: COMPACTION_EPOCH, sequence: Math.min(7, through) }
  })
  if (!result.ok) throw new Error('compaction fixture must be readable')
  const frame: AgentSessionSubscribeEvent = {
    type: 'batch',
    sessionId: COMPACTION_IDENTITY.sessionId,
    batch: {
      cursor: result.page.window.nextCursor,
      items: result.page.items,
      removedItemIds: result.page.removedItemIds,
      submissions: result.page.submissions
    },
    fence: 1,
    hostNow: 0
  }
  const older = readAgentSessionHistory(reader, {
    sessionId: COMPACTION_IDENTITY.sessionId,
    direction: 'before',
    cursor: { epoch: COMPACTION_EPOCH, sequence: Math.min(9, through) },
    limit: 2
  })
  if (!older.ok) throw new Error('compaction fixture older page must be readable')
  const tail = readAgentSessionHistory(reader, {
    sessionId: COMPACTION_IDENTITY.sessionId,
    direction: 'tail',
    limit: 2
  })
  if (!tail.ok) throw new Error('compaction fixture tail must be readable')
  return structuredClone({ snapshot, frame, older: older.page, tail: tail.page })
}
