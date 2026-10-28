import { agentJournalLinkageFields } from '../../shared/agent-session-journal-producer'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type {
  StructuredAgentSessionAppendOptions,
  StructuredAgentSessionItemAppendOptions
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import {
  AGENT_SESSION_TEXT_CHECKPOINT_MS,
  createAgentSessionDeltaCoalescer,
  type AgentSessionDeltaCoalescerDeps
} from '../native-chat/agent-session-wire/agent-session-delta-coalescer'
import type { ClaudeSubagentLinkageSource } from './claude-subagent-linkage'

export type ClaudeStreamedTextCheckpointDeps = {
  /** Rewrite accumulated text; ended marks the last write when no final frame will arrive. */
  persist: (
    identity: AgentJournalItemIdentity,
    text: string,
    options: StructuredAgentSessionItemAppendOptions,
    ended?: ClaudeStreamedBlockEnd
  ) => boolean | void
  producer: ClaudeSubagentLinkageSource
  coalesceMs?: number
  schedule?: AgentSessionDeltaCoalescerDeps['schedule']
}

/** Host time of completion or interruption. */
export type ClaudeStreamedBlockEnd = { completedAt?: number }

export type ClaudeStreamedTextCheckpoints = {
  /** Coalesce deltas on a fixed checkpoint interval to avoid per-token journal rewrites. */
  append: (
    identity: AgentJournalItemIdentity,
    text: string,
    parentToolUseId?: string | null,
    options?: StructuredAgentSessionItemAppendOptions
  ) => void
  flush: () => void
  /** Correct provisional producers even for blocks that stopped receiving checkpoints. */
  reattribute: () => void
  forget: (key: string) => void
  latest: (key: string) => string | undefined
  /** End matching rows whose final frames will never arrive; discard empty blocks. */
  finish: (ended: ClaudeStreamedBlockEnd, only?: (key: string) => boolean) => void
  /** Clear settled streams while preserving refused terminal snapshots for retry. */
  settle: () => void
  readonly pending: number
  dispose: () => void
}

function sameLinkage(
  left: StructuredAgentSessionAppendOptions,
  right: StructuredAgentSessionAppendOptions
): boolean {
  return (
    left.agentId === right.agentId &&
    left.parentAgentId === right.parentAgentId &&
    left.providerParentRef === right.providerParentRef &&
    left.producerKind === right.producerKind &&
    left.attempt === right.attempt
  )
}

export function createClaudeStreamedTextCheckpoints(
  deps: ClaudeStreamedTextCheckpointDeps
): ClaudeStreamedTextCheckpoints {
  const identities = new Map<
    string,
    {
      identity: AgentJournalItemIdentity
      options: StructuredAgentSessionItemAppendOptions
      ended?: ClaudeStreamedBlockEnd
    }
  >()
  /** Retain producer scope because persist has no frame to read. */
  const scopes = new Map<string, string | null>()
  /** Last written linkage, used only to skip revisions that change nothing. */
  const writtenLinkage = new Map<string, StructuredAgentSessionAppendOptions>()

  /** Resolve each checkpoint afresh; later announcements revise provisional producers on the same row. */
  const producerOptions = (key: string): StructuredAgentSessionAppendOptions => {
    const scope = scopes.get(key) ?? null
    if (scope === null) {
      return {}
    }
    return agentJournalLinkageFields(deps.producer.settledLinkageFor(scope).linkage)
  }

  const persist = (key: string, text: string): boolean => {
    const block = identities.get(key)
    if (!block) {
      return true
    }
    const options = { ...block.options, ...producerOptions(key) }
    if (deps.persist(block.identity, text, options, block.ended) === false) {
      return false
    }
    writtenLinkage.set(key, options)
    if (block.ended) {
      drop(key)
    }
    return true
  }

  const coalescer = createAgentSessionDeltaCoalescer({
    ...(deps.coalesceMs === undefined ? {} : { windowMs: deps.coalesceMs }),
    ...(deps.schedule ? { schedule: deps.schedule } : {}),
    checkpointMs: () => AGENT_SESSION_TEXT_CHECKPOINT_MS,
    emit: persist
  })

  const drop = (key: string): void => {
    coalescer.forget(key)
    identities.delete(key)
    scopes.delete(key)
    writtenLinkage.delete(key)
  }

  return {
    append: (
      identity,
      text,
      parentToolUseId = null,
      options = { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    ) => {
      const key = agentJournalItemKey(identity)
      if (!identities.has(key)) {
        identities.set(key, { identity, options })
      }
      scopes.set(key, parentToolUseId)
      coalescer.append(key, text)
    },
    flush: () => {
      coalescer.flushAll()
    },
    reattribute: () => {
      for (const [key, block] of identities) {
        const text = coalescer.snapshot(key)?.text
        if (text === undefined) {
          continue
        }
        const options = { ...block.options, ...producerOptions(key) }
        const written = writtenLinkage.get(key)
        if (written && sameLinkage(written, options)) {
          continue
        }
        if (persist(key, text)) {
          coalescer.markFlushed(key)
        }
      }
    },
    forget: drop,
    latest: (key) => coalescer.snapshot(key)?.text,
    finish: (ended, only) => {
      for (const [key, block] of identities) {
        if (only && !only(key)) {
          continue
        }
        block.ended ??= ended
        coalescer.flush(key, true)
      }
    },
    settle: () => {
      for (const [key, block] of identities) {
        if (!block.ended) {
          drop(key)
        }
      }
    },
    get pending() {
      return identities.size
    },
    dispose: () => {
      coalescer.dispose()
      identities.clear()
      scopes.clear()
      writtenLinkage.clear()
    }
  }
}
