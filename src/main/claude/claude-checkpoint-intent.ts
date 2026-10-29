import { isDeepStrictEqual } from 'node:util'
import {
  agentJournalItemKey,
  parseAgentJournalItemKey
} from '../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemIdentity,
  AgentJournalMessageItem
} from '../../shared/agent-session-journal-types'
import {
  jsonTextBytes,
  jsonValueBytes
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink-estimate'
import type { StructuredAgentSessionItemAppendOptions } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { StructuredAgentSessionTransitionStep } from '../native-chat/agent-session-wire/structured-agent-session-transition'

export type ClaudeCheckpointIntent = {
  identity: AgentJournalItemIdentity
  role: 'assistant' | 'reasoning'
  suffix: readonly string[]
  replacement?: AgentJournalMessageItem
  ended?: { completedAt?: number }
  options: StructuredAgentSessionItemAppendOptions
}

/** Resolve content only after preceding admitted operations; delivery buffers never own the baseline. */
export function claudeCheckpointStep(
  intent: ClaudeCheckpointIntent
): StructuredAgentSessionTransitionStep {
  return {
    kind: 'materialized-item',
    reservedBytes: jsonValueBytes(intent) + 512,
    options: intent.options,
    resolve: (journal) => {
      const canonical = journal.canonicalItemId(agentJournalItemKey(intent.identity))
      const prior = journal.item(canonical)
      const saved = prior?.body
      if (saved && (saved.kind !== 'message' || saved.role !== intent.role)) {
        throw new Error('incompatible Claude checkpoint content')
      }
      const previous = saved?.kind === 'message' ? saved : undefined
      const baseline = intent.replacement ??
        previous ?? { kind: 'message' as const, role: intent.role, blocks: [] }
      const terminal = previous?.state === 'completed' || intent.ended !== undefined
      const body: AgentJournalMessageItem = {
        ...baseline,
        ...(intent.role === 'reasoning'
          ? { state: terminal ? 'completed' : (baseline.state ?? 'running') }
          : {}),
        ...(previous?.completedAt !== undefined
          ? { completedAt: previous.completedAt }
          : intent.ended?.completedAt !== undefined && intent.role === 'reasoning'
            ? { completedAt: intent.ended.completedAt }
            : {})
      }
      const last = body.blocks.at(-1)
      const text = last?.type === 'text' ? last.text : ''
      const chunks = text ? [text, ...intent.suffix] : intent.suffix
      if (!previous && !intent.replacement && chunks.length === 0) {
        return null
      }
      if (chunks.length === 0 && !body.blocks.length) {
        return null
      }
      const identity = parseAgentJournalItemKey(canonical) ?? intent.identity
      const appending = intent.suffix.length > 0
      // Size the future blocks with an empty placeholder; no combined string exists yet.
      const blocks = appending
        ? [
            ...(last?.type === 'text' ? body.blocks.slice(0, -1) : body.blocks),
            { ...(last?.type === 'text' ? last : {}), type: 'text' as const, text: '' }
          ]
        : body.blocks
      const shell = { ...body, blocks }
      const bytes =
        jsonValueBytes({ identity, body: shell }) +
        (appending ? jsonTextBytes(chunks) - 2 : 0) +
        512
      if (
        !appending &&
        previous &&
        isDeepStrictEqual(previous, body) &&
        ['agentId', 'parentAgentId', 'providerParentRef', 'producerKind', 'attempt'].every(
          (key) => Reflect.get(prior ?? {}, key) === Reflect.get(intent.options, key)
        )
      ) {
        return null
      }
      return {
        bytes,
        compose: () => ({
          identity,
          body: appending
            ? {
                ...body,
                blocks: [
                  ...blocks.slice(0, -1),
                  { ...(last?.type === 'text' ? last : {}), type: 'text', text: chunks.join('') }
                ]
              }
            : body
        })
      }
    }
  }
}
