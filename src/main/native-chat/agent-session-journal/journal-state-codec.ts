// Versioned reducer snapshots preserve insertion order and the presence of undefined echo declarations.

import { z } from 'zod'
import {
  isAdmissibleAgentJournalRenderItem,
  isAdmissibleAgentJournalMessageBody,
  AgentJournalTurnScopeSchema
} from '../../../shared/agent-session-journal-schemas'
import { AgentJournalSubmissionSchema } from '../../../shared/agent-session-journal-submission-schema'
import { AgentSessionExecutionOptionsSchema } from '../../../shared/agent-session-execution-options'
import { AgentSessionFailureFactSchema } from '../../../shared/agent-session-failure-fact-schema'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission,
  AgentJournalMessageItem
} from '../../../shared/agent-session-journal-types'
import type { QueuedMessageRow } from './queued-message-table'
import type { JournalReducerState } from './journal-reducer'
import { JournalDerivedTurnScope } from './journal-derived-turn-scope'

export const JOURNAL_STATE_CODEC_VERSION = 1

const number = z.number().finite()
const cursor = z.object({ epoch: z.string(), sequence: number })
const place = z.object({
  sequence: number,
  observedAt: number,
  turnScope: AgentJournalTurnScopeSchema.optional()
})
const handle = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('codex'), threadId: z.string() }),
  z.object({ kind: z.literal('claude'), sessionId: z.string(), leafUuid: z.string().nullable() }),
  z.object({ kind: z.literal('opaque'), agent: z.string(), value: z.string() })
])
const pauseMarks = z.object({
  cleared: z
    .object({
      sequence: number,
      operationId: z.string(),
      messageIds: z.array(z.string()),
      lifted: z.literal(true).optional()
    })
    .optional(),
  latestStop: z
    .object({
      sequence: number,
      event: z.object({
        reason: z.string(),
        at: number,
        turnId: z.string().optional(),
        caller: z.string().optional()
      })
    })
    .nullable(),
  resumedSequence: number,
  reopenedSequence: number
})
const card = z.object({
  messageId: z.string(),
  position: number,
  body: z.custom<AgentJournalMessageItem>(isAdmissibleAgentJournalMessageBody),
  fingerprint: z.string(),
  state: z.enum(['waiting', 'dispatched', 'returned', 'withdrawn']),
  holdReason: z.string().nullable(),
  returnedReason: z.string().nullable(),
  returnedRejection: AgentSessionFailureFactSchema.nullable(),
  consumedAs: z.string().nullable(),
  queuedAt: cursor.nullable(),
  options: AgentSessionExecutionOptionsSchema.optional()
})
const submission = AgentJournalSubmissionSchema.extend({
  acceptedSequence: number.optional(),
  origin: z.enum(['client', 'host']).optional()
})

function checked<T>(schema: z.ZodType): z.ZodType<T> {
  // SAFETY: each schema below checks the stored shape; retain the original object, including unknown annotations.
  return z.custom<T>((value) => schema.safeParse(value).success)
}

function entries<T>(value: z.ZodType<T>) {
  return z.array(z.tuple([z.string(), value]))
}

// Every reducer key must have an explicit stored representation, including separately stored items.
const fields = {
  sessionId: z.string(),
  epoch: z.string(),
  lastSequence: z.number().int().nonnegative(),
  lastActivityAt: number,
  oldestSequence: number,
  highestFence: number,
  items: z.array(z.custom<AgentJournalRenderItem>(isAdmissibleAgentJournalRenderItem)),
  itemFences: entries(number),
  itemExecutionOwners: entries(number),
  providerActivityAt: z.array(z.tuple([number, number])),
  tombstones: entries(number),
  removedTurnIds: z.array(z.string()),
  submissions: entries(checked<AgentJournalSubmission>(submission)),
  receipts: entries(
    z.object({
      clientMessageId: z.string(),
      providerItemId: z.string(),
      cursor,
      acceptedAt: number
    })
  ),
  aliases: entries(z.string()),
  itemEchoes: z.array(z.union([z.tuple([z.string()]), z.tuple([z.string(), z.unknown()])])),
  appliedSettlementIds: z.array(z.string()),
  derivedTurnScope: z.string().nullable(),
  latestAcceptedTurnSequence: number,
  queuePauseMarks: checked<JournalReducerState['queuePauseMarks']>(pauseMarks),
  stoppedHistoryCarried: entries(z.array(z.string())),
  queuedHandOffPlaces: entries(
    checked<Pick<AgentJournalRenderItem, 'sequence' | 'observedAt' | 'turnScope'>>(place)
  ),
  normalizedHandOffs: z.array(z.string()),
  queue: z.object({
    revision: number,
    cards: entries(checked<QueuedMessageRow>(card))
  }),
  historyOrigin: checked<JournalReducerState['historyOrigin']>(
    z
      .object({
        providerHandle: handle,
        raw: z.unknown()
      })
      .nullable()
  )
} satisfies Record<keyof JournalReducerState, z.ZodType>
const stateV1 = z.object(fields).omit({ items: true })

// Live Stop settlement belongs to its process; only the row-derived pause facts survive restart.
function durableQueuePauseMarks(
  marks: JournalReducerState['queuePauseMarks']
): JournalReducerState['queuePauseMarks'] {
  const stop = marks.latestStop
  return { ...marks, latestStop: stop && { sequence: stop.sequence, event: stop.event } }
}

export function encodeJournalState(state: JournalReducerState): {
  stateJson: string
  items: { itemId: string; itemJson: string; ordinal: number }[]
} {
  const stored = {
    sessionId: state.sessionId,
    epoch: state.epoch,
    lastSequence: state.lastSequence,
    lastActivityAt: state.lastActivityAt,
    oldestSequence: state.oldestSequence,
    highestFence: state.highestFence,
    itemFences: [...state.itemFences],
    itemExecutionOwners: [...state.itemExecutionOwners],
    providerActivityAt: [...state.providerActivityAt],
    tombstones: [...state.tombstones],
    removedTurnIds: [...state.removedTurnIds],
    submissions: [...state.submissions],
    receipts: [...state.receipts],
    aliases: [...state.aliases],
    itemEchoes: [...state.itemEchoes].map(([key, value]) =>
      value === undefined ? [key] : [key, value]
    ),
    appliedSettlementIds: [...state.appliedSettlementIds],
    derivedTurnScope: state.derivedTurnScope.snapshot(),
    latestAcceptedTurnSequence: state.latestAcceptedTurnSequence,
    queuePauseMarks: durableQueuePauseMarks(state.queuePauseMarks),
    stoppedHistoryCarried: [...state.stoppedHistoryCarried],
    queuedHandOffPlaces: [...state.queuedHandOffPlaces],
    normalizedHandOffs: [...state.normalizedHandOffs],
    queue: { revision: state.queue.revision, cards: [...state.queue.cards] },
    historyOrigin: state.historyOrigin
  } satisfies Record<Exclude<keyof JournalReducerState, 'items'>, unknown>
  return {
    stateJson: JSON.stringify(stored),
    items: [...state.items].map(([itemId, item], ordinal) => ({
      itemId,
      itemJson: JSON.stringify(item),
      ordinal
    }))
  }
}

/** Keep every shipped version's decoder here; future codecs migrate its decoded state forward. */
export function decodeJournalState(
  version: number,
  stateJson: string,
  itemJsons: readonly string[]
): JournalReducerState | null {
  if (version !== 1) {
    return null
  }
  const stored = stateV1.parse(JSON.parse(stateJson))
  const items = fields.items.parse(itemJsons.map((json) => JSON.parse(json)))
  return {
    sessionId: stored.sessionId,
    epoch: stored.epoch,
    lastSequence: stored.lastSequence,
    lastActivityAt: stored.lastActivityAt,
    oldestSequence: stored.oldestSequence,
    highestFence: stored.highestFence,
    items: new Map(items.map((item) => [item.itemId, item])),
    itemFences: new Map(stored.itemFences),
    itemExecutionOwners: new Map(stored.itemExecutionOwners),
    providerActivityAt: new Map(stored.providerActivityAt),
    tombstones: new Map(stored.tombstones),
    removedTurnIds: new Set(stored.removedTurnIds),
    submissions: new Map(stored.submissions),
    receipts: new Map(stored.receipts),
    aliases: new Map(stored.aliases),
    itemEchoes: new Map(stored.itemEchoes.map((entry) => [entry[0], entry[1]])),
    appliedSettlementIds: new Set(stored.appliedSettlementIds),
    derivedTurnScope: JournalDerivedTurnScope.restore(stored.derivedTurnScope),
    latestAcceptedTurnSequence: stored.latestAcceptedTurnSequence,
    queuePauseMarks: durableQueuePauseMarks(stored.queuePauseMarks),
    stoppedHistoryCarried: new Map(stored.stoppedHistoryCarried),
    queuedHandOffPlaces: new Map(stored.queuedHandOffPlaces),
    normalizedHandOffs: new Set(stored.normalizedHandOffs),
    queue: { revision: stored.queue.revision, cards: new Map(stored.queue.cards) },
    historyOrigin: stored.historyOrigin
  }
}
