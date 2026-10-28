import type {
  AgentJournalCursor,
  AgentJournalRenderItem
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'
import { MAX_RETAINED_ITEMS } from '../../../shared/structured-agent-session-item-retention'
import { sameJournalCursor } from '../agent-session-journal/journal-cursor'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { journalTextField } from '../agent-session-journal/journal-text-rows'
import { subscriberHistoryReader } from './agent-session-bounded-frames'
import {
  readAgentSessionTextWindow,
  agentSessionTextWindowPatches,
  type TextBaseline
} from './agent-session-text-window'
import { emptyAgentSessionBatch } from './agent-session-empty-batch'
import { snapshotLatestTurn } from './agent-session-history-latest-turn'
import {
  agentSessionPublishedWorkFields,
  type AgentSessionPublishedWork
} from './agent-session-published-work'
import type { SubscriberDeliveryPort } from './agent-session-subscriber-catch-up'
import type { Subscriber } from './structured-agent-session-subscribers'

/** Only an observed, unshortened baseline can receive live suffixes; reconnects use whole items. */
export class AgentSessionTextDelivery {
  private readonly baselines = new Map<string, TextBaseline>()
  private readonly pending = new Set<string>()
  private inspected?: AgentJournalCursor

  observe(event: AgentSessionSubscribeEvent): void {
    if (event.type === 'end') {
      return
    }
    if (event.type !== 'batch') {
      this.baselines.clear()
      this.pending.clear()
      this.inspected = undefined
    }
    const items = event.type === 'batch' ? event.batch.items : event.page.items
    for (const item of items) {
      this.remember(item)
    }
    if (event.type === 'batch') {
      for (const id of event.batch.removedItemIds) {
        this.baselines.delete(id)
      }
      for (const patch of event.batch.textPatches?.items ?? []) {
        const baseline = this.baselines.get(patch.item.itemId)
        if (baseline) {
          baseline.revision = patch.item.revision
          baseline.lengths.set(patch.field, patch.baseLength + patch.suffix.length)
          baseline.bodyBytes += Buffer.byteLength(JSON.stringify(patch.suffix), 'utf8') - 2
        }
      }
    }
  }

  tryDeliver(
    port: SubscriberDeliveryPort,
    subscriber: Subscriber,
    journal: AgentSessionJournal,
    work: AgentSessionPublishedWork | undefined,
    hostNow: number
  ): boolean {
    const after = this.inspected ?? subscriber.cursor
    const cursor = journal.cursor()
    if (sameJournalCursor(after, cursor)) {
      return this.pending.size > 0
    }
    const window = readAgentSessionTextWindow(journal, after)
    if (!window) {
      return false
    }
    const patches = subscriber.textPatches
      ? agentSessionTextWindowPatches(
          window,
          subscriber.cursor,
          this.baselines,
          subscriberHistoryReader(subscriber).budgetBytes,
          subscriber.boundedFrames
        )
      : null
    if (patches) {
      port.emit(
        subscriber,
        {
          type: 'batch',
          sessionId: subscriber.sessionId,
          batch: { ...emptyAgentSessionBatch(cursor), textPatches: patches },
          fence: subscriber.fence,
          hostNow,
          ...this.fields(journal, work)
        },
        { currentWork: work }
      )
      subscriber.cursor = cursor
      return true
    }
    if (
      subscriber.textPatches &&
      window.rows.some((row) => !this.baselines.get(row.itemId)?.shortened)
    ) {
      return false
    }
    const due = new Set<string>()
    for (const row of window.rows) {
      const current = window.items.get(row.itemId)
      const length = current ? journalTextField(current.body, row.field)?.length : undefined
      if (length === undefined) {
        return false
      }
      const previous = this.baselines.get(row.itemId)?.lengths.get(row.field) ?? 0
      this.pending.add(row.itemId)
      if (previous === 0 || length >= Math.max(previous + 32, Math.ceil(previous * 1.125))) {
        due.add(row.itemId)
      }
    }
    this.inspected = cursor
    if (due.size > 0) {
      this.flush(port, subscriber, journal, work, hostNow, due)
    }
    return true
  }

  flush(
    port: SubscriberDeliveryPort,
    subscriber: Subscriber,
    journal: AgentSessionJournal,
    work: AgentSessionPublishedWork | undefined,
    hostNow: number,
    selected: ReadonlySet<string> = this.pending
  ): void {
    const cursor = this.inspected
    if (!cursor || this.pending.size === 0) {
      return
    }
    const reader = subscriberHistoryReader(subscriber)
    const items = journal.snapshot().items.filter((item) => selected.has(item.itemId))
    const completes = items.length === this.pending.size
    // Only the final frame advances, so a partial transport failure can replay every withheld row.
    for (let index = 0; index < items.length; index++) {
      const item = items[index]
      port.emit(
        subscriber,
        {
          type: 'batch',
          sessionId: subscriber.sessionId,
          batch: {
            ...emptyAgentSessionBatch(
              completes && index === items.length - 1 ? cursor : subscriber.cursor
            ),
            items: [reader.form(item).item]
          },
          fence: subscriber.fence,
          hostNow,
          ...this.fields(journal, work)
        },
        { currentWork: work }
      )
      if (!port.isActive(subscriber)) {
        return
      }
      this.pending.delete(item.itemId)
      const baseline = this.baselines.get(item.itemId)
      if (baseline) {
        for (const field of baseline.lengths.keys()) {
          baseline.lengths.set(field, journalTextField(item.body, field)?.length ?? 0)
        }
      }
    }
    if (this.pending.size === 0) {
      subscriber.cursor = cursor
      this.inspected = undefined
    }
  }

  private fields(journal: AgentSessionJournal, work: AgentSessionPublishedWork | undefined) {
    return work
      ? agentSessionPublishedWorkFields(journal, work)
      : { latestTurn: snapshotLatestTurn(journal.snapshot()) }
  }

  private remember(item: AgentJournalRenderItem): void {
    this.baselines.delete(item.itemId)
    if (item.body.kind === 'message') {
      this.baselines.set(item.itemId, {
        revision: item.revision,
        lengths: new Map(
          item.body.blocks.flatMap((block, field) =>
            block.type === 'text' ? [[field, block.text.length] as const] : []
          )
        ),
        shortened: item.shortened === true,
        bodyBytes: Buffer.byteLength(JSON.stringify(item.body), 'utf8')
      })
    }
    while (this.baselines.size > MAX_RETAINED_ITEMS) {
      const oldest = this.baselines.keys().next().value
      if (oldest === undefined) {
        break
      }
      this.baselines.delete(oldest)
    }
  }
}
