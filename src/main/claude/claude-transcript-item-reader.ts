import { journalLifecycleItemMutation } from '../native-chat/agent-session-journal/journal-row-builders'
import {
  continuedOutsideNotice,
  continuedOutsideRecordId,
  createHistoryCatchUpBatch
} from '../native-chat/agent-session-wire/structured-agent-session-history-catch-up'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type { AgentJournalItemIdentity } from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalRenderItem,
  type AgentJournalTurnScope
} from '../../shared/agent-session-journal-types'
import { HISTORY_CATCH_UP_MAX_OPERATIONS } from '../native-chat/agent-session-wire/structured-agent-session-history-catch-up'
import type { StructuredAgentSessionTransitionJournal } from '../native-chat/agent-session-wire/structured-agent-session-transition'
import { parseAgentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { claudePromptUuidForSubmission } from './structured/claude-structured-session-id'

/** Every saved item used by the projection is a conditional commit dependency, even if equal. */
export function createClaudeTranscriptItemReader(
  journal: StructuredAgentSessionTransitionJournal,
  sessionId: string
) {
  const dependencies = new Map<string, AgentJournalRenderItem>()
  let localPrompts: Map<string, string> | undefined
  const saved = (key: string) => {
    const held = dependencies.get(key)
    if (held) {
      return held
    }
    const item = journal.item(journal.canonicalItemId(key))
    if (item) {
      dependencies.set(key, item)
    }
    if (dependencies.size > HISTORY_CATCH_UP_MAX_OPERATIONS) {
      throw new Error('too-large')
    }
    return item
  }
  // Lost acknowledgements lose aliases, but the prompt UUID can still name its saved submission.
  const localPrompt = (uuid: string) => {
    if (!localPrompts) {
      const prompts = new Map<string, string>()
      journal.visitItems((itemId, _sequence, body) => {
        if (
          body.kind === 'message' &&
          body.role === 'user' &&
          parseAgentJournalItemKey(itemId)?.provider === 'orca'
        ) {
          prompts.set(claudePromptUuidForSubmission(sessionId, itemId), itemId)
        }
      })
      localPrompts = prompts
    }
    const key = localPrompts.get(uuid)
    // Depend on the persisted key, without creating a provider alias or acknowledging delivery.
    return key ? saved(key) : null
  }
  const scopeOf = (item: AgentJournalRenderItem): AgentJournalTurnScope => {
    const scope = item.turnScope ?? AGENT_JOURNAL_THREAD_SCOPE
    if (scope.kind === 'turn') {
      const parent = saved(scope.turnItemId)
      if (!parent || parent.body.kind !== 'turn' || parent.body.state === 'running') {
        throw new Error('unsettled-history-turn')
      }
    }
    return scope
  }
  const promptScope = (item: AgentJournalRenderItem, queued: boolean) => {
    if (queued) {
      const scope = scopeOf(item)
      return scope.kind === 'turn' ? scope : undefined
    }
    let scope: AgentJournalTurnScope | undefined
    journal.visitItems((itemId, _sequence, body) => {
      if (
        body.kind === 'turn' &&
        body.userItemId &&
        journal.canonicalItemId(body.userItemId) === item.itemId
      ) {
        const turn = saved(itemId)
        if (turn) {
          scope = scopeOf({ ...item, turnScope: { kind: 'turn', turnItemId: itemId } })
        }
      }
    })
    return scope
  }
  return { saved, localPrompt, scopeOf, promptScope, dependencies }
}

export function claudeTranscriptTransitionWriter(input: {
  journal: StructuredAgentSessionTransitionJournal
  aliases: Map<string, AgentJournalItemIdentity>
  mutations: Map<string, ReturnType<typeof journalLifecycleItemMutation>>
  saved: (key: string) => AgentJournalRenderItem | null
  append: StructuredAgentSessionEventSink['appendItem']
}): NonNullable<StructuredAgentSessionEventSink['tryAppendTransition']> {
  const { aliases, mutations, saved, append } = input
  const projectedItem = (key: string): AgentJournalRenderItem | null => {
    const canonical = input.journal.canonicalItemId(key)
    const row = mutations.get(canonical)
    return row?.kind === 'item'
      ? {
          ...row,
          itemId: canonical,
          revision: 1,
          sequence: 0,
          observedAt: row.observedAt ?? 0
        }
      : saved(canonical)
  }
  const projectedJournal: StructuredAgentSessionTransitionJournal = {
    epoch: input.journal.epoch,
    canonicalItemId: (key) => {
      const alias = aliases.get(key)
      return input.journal.canonicalItemId(alias ? agentJournalItemKey(alias) : key)
    },
    item: projectedItem,
    itemBody: (key) => projectedItem(key)?.body ?? null,
    visitItems: (...args) => input.journal.visitItems(...args),
    visitItemsWithLinkage: (...args) => input.journal.visitItemsWithLinkage(...args)
  }
  return (transition) => {
    for (const step of transition.steps) {
      if (step.kind === 'settlement') {
        throw new Error('unexpected-history-settlement')
      }
      const resolved =
        step.kind === 'item'
          ? step.resolve(projectedJournal)
          : step.resolve(projectedJournal)?.compose()
      if (resolved) {
        append(resolved.identity, resolved.body, step.options)
      }
    }
    return { accepted: true }
  }
}

export function claudeTranscriptImportBatch(input: {
  rows: ReturnType<typeof journalLifecycleItemMutation>[]
  dependencies: Map<string, AgentJournalRenderItem>
  saved: (key: string) => AgentJournalRenderItem | null
  rewound: boolean | null
  sessionId: string
  epoch: string
  providerSessionId: string
  uuids: string[]
}) {
  const { rows, dependencies, saved, uuids } = input
  const batch = createHistoryCatchUpBatch()
  const firstCreated = rows.find(
    (row) =>
      row.kind === 'item' &&
      row.body.kind !== 'turn' &&
      !dependencies.has(agentJournalItemKey(row.identity))
  )
  if (input.rewound !== null && firstCreated) {
    batch.push(
      journalLifecycleItemMutation(
        { turnScope: AGENT_JOURNAL_THREAD_SCOPE },
        {
          provider: 'legacy',
          agent: 'claude',
          sessionId: input.sessionId,
          recordId: continuedOutsideRecordId(agentJournalItemKey(firstCreated.identity))
        },
        continuedOutsideNotice(input.rewound)
      )
    )
  }
  const revised = new Set<string>()
  for (const row of rows) {
    const key = agentJournalItemKey(row.identity)
    const existing = saved(key)
    if (existing && row.kind === 'item') {
      batch.revise(row, { canonicalItemId: existing.itemId, revision: existing.revision })
      revised.add(key)
    } else {
      batch.push(row)
    }
  }
  for (const [key, item] of dependencies) {
    if (!revised.has(key)) {
      batch.expectItem(key, { canonicalItemId: item.itemId, revision: item.revision })
    }
  }
  const plan = batch.finish('claude-history-import', [
    input.epoch,
    input.providerSessionId,
    uuids,
    rows
  ])
  return plan
}
