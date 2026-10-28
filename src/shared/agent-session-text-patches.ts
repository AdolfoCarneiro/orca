import type { AgentJournalCursor, AgentJournalRenderItem } from './agent-session-journal-types'
import type { AgentSessionJournalBatch } from './agent-session-wire'

export const AGENT_SESSION_TEXT_PATCHES_CLIENT_CAPABILITY = 'agent-session.text-patches.v1' as const

export function clientReadsAgentSessionTextPatches(context: {
  clientKind?: string
  clientCapabilities?: readonly string[]
}): boolean {
  return (
    context.clientKind === undefined ||
    context.clientCapabilities?.includes(AGENT_SESSION_TEXT_PATCHES_CLIENT_CAPABILITY) === true
  )
}

export function agentSessionTextItemsAfterBatch(
  state: {
    cursor: AgentJournalCursor | null
    items: readonly AgentJournalRenderItem[]
    hasOlder: boolean
  },
  batch: AgentSessionJournalBatch
): AgentJournalRenderItem[] | null {
  const patches = batch.textPatches
  if (!patches || batch.cursor.sequence === state.cursor?.sequence) {
    return []
  }
  if (
    state.cursor?.epoch !== patches.after.epoch ||
    state.cursor.sequence !== patches.after.sequence
  ) {
    return null
  }
  return applyAgentSessionTextPatches(
    state.items,
    patches,
    state.hasOlder ? state.items[0]?.sequence : undefined
  )
}

export type AgentSessionTextPatches = {
  after: AgentJournalCursor
  items: {
    item: Omit<AgentJournalRenderItem, 'body'>
    field: number
    predecessor: number
    baseLength: number
    suffix: string
  }[]
}

/** Missing off-page items stay off-page; a broken retained baseline requires hydration. */
export function applyAgentSessionTextPatches(
  items: readonly AgentJournalRenderItem[],
  patches: AgentSessionTextPatches,
  firstRetainedSequence?: number
): AgentJournalRenderItem[] | null {
  const byId = new Map(items.map((item) => [item.itemId, item]))
  const updated: AgentJournalRenderItem[] = []
  for (const patch of patches.items) {
    const prior = byId.get(patch.item.itemId)
    if (!prior) {
      if (firstRetainedSequence !== undefined && patch.item.sequence < firstRetainedSequence) {
        continue
      }
      return null
    }
    if (prior.revision >= patch.item.revision) {
      continue
    }
    const block = prior.body.kind === 'message' ? prior.body.blocks[patch.field] : undefined
    if (
      prior.shortened ||
      prior.revision !== patch.predecessor ||
      prior.body.kind !== 'message' ||
      block?.type !== 'text' ||
      block.text.length !== patch.baseLength
    ) {
      return null
    }
    const next = {
      ...patch.item,
      body: {
        ...prior.body,
        blocks: prior.body.blocks.map((entry, field) =>
          field === patch.field ? { type: 'text' as const, text: block.text + patch.suffix } : entry
        )
      }
    }
    byId.set(next.itemId, next)
    updated.push(next)
  }
  return updated
}
