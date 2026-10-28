import { parseJournalRow } from '../../native-chat/agent-session-journal/journal-row-schema'
import type { StructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-host'
import {
  conversationRecordReader,
  resolveLineageRunningSession
} from './structured-session-lineage'
import {
  observeMailHistoryChanges,
  flushMailHistoryChanges,
  beginMailHistoryInventory,
  observeMailHistoryReference
} from './structured-mail-history-revision'
export type MailCreationHistory = { members: ReadonlySet<string>; opaque: boolean }
export const mailMemberKey = (runId: string, id: string): string => JSON.stringify([runId, id])

type Domain = Map<string, MailCreationHistory>
class OriginalMailHistory {
  private readonly domains = new Map<string, Domain>()
  private readonly members = new Set<string>()
  private readonly dependents = new Map<string, Set<string>>()
  private readonly roots = new Map<string, Set<string>>()
  private readonly lineages = new Map<string, readonly string[]>()
  private initialized = false
  private readonly registered = new Set<string>()
  private readonly listeners = new Set<(members: ReadonlySet<string>) => void>()
  private unsubscribeChanges: (() => void) | undefined
  constructor(private readonly host: StructuredAgentSessionHost) {}
  private readonly changed = (
    changes: readonly { sessionId: string; operationId: string | null }[]
  ) => {
    const wake = new Set<string>()
    const expanded = changes.flatMap((change) =>
      change.operationId === null
        ? [...new Set([change.sessionId, ...(this.roots.get(change.sessionId) ?? [])])].map(
            (sessionId) => ({ sessionId, operationId: null })
          )
        : [change]
    )
    const full = new Set(
      expanded.filter((change) => change.operationId === null).map((change) => change.sessionId)
    )
    const affected = new Map(
      expanded
        .filter((change) => change.operationId === null || !full.has(change.sessionId))
        .map((change) => [JSON.stringify([change.sessionId, change.operationId]), change])
    )
    for (const change of affected.values()) {
      const prior = this.domains.get(change.sessionId)
      const before = this.domainMembers(prior)
      if (change.operationId === null || !prior) {
        this.domains.set(change.sessionId, this.readDomain(change.sessionId))
      } else {
        prior.delete(change.operationId)
        for (const [id, evidence] of this.readDomain(change.sessionId, change.operationId)) {
          prior.set(id, evidence)
        }
      }
      const after = this.domainMembers(this.domains.get(change.sessionId))
      const changed = JSON.stringify(before) !== JSON.stringify(after)
      if (changed) {
        for (const key of [
          ...before.members,
          ...after.members,
          ...(this.dependents.get(change.sessionId) ?? [])
        ]) {
          wake.add(key)
        }
      }
    }
    if (wake.size) {
      this.rebuildMembers()
      for (const listener of this.listeners) {
        listener(wake)
      }
    }
  }
  private rebuildMembers(): void {
    this.members.clear()
    for (const domain of this.domains.values()) {
      for (const key of this.domainMembers(domain).members) {
        this.members.add(key)
      }
    }
  }
  observe(listener: (members: ReadonlySet<string>) => void): () => void {
    this.unsubscribeChanges ??= observeMailHistoryChanges(
      this.host.deps.journalDatabase.db,
      this.changed
    )
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
      if (!this.listeners.size) {
        this.unsubscribeChanges?.()
        this.unsubscribeChanges = undefined
        this.dependents.clear()
        this.registered.clear()
      }
    }
  }
  forget(key: string): void {
    this.registered.delete(key)
    for (const ids of this.dependents.values()) {
      ids.delete(key)
    }
  }
  read(key?: string): MailCreationHistory {
    const temporary = this.unsubscribeChanges
      ? undefined
      : observeMailHistoryChanges(this.host.deps.journalDatabase.db, this.changed)
    try {
      flushMailHistoryChanges(this.host.deps.journalDatabase.db)
    } finally {
      temporary?.()
    }
    if (!this.initialized) {
      for (const record of this.host.deps.store.listConversations()) {
        if (!this.domains.has(record.sessionId)) {
          this.domains.set(record.sessionId, this.readDomain(record.sessionId))
        }
      }
      this.initialized = true
      this.rebuildMembers()
    }
    if (key && !this.registered.has(key)) {
      this.registered.add(key)
      for (const [sessionId, domain] of this.domains) {
        if (domain.size) {
          const sources = this.dependents.get(sessionId) ?? new Set<string>()
          this.dependents.set(sessionId, sources)
          sources.add(key)
        }
      }
    }
    return { members: this.members, opaque: true }
  }
  private domainMembers(domain?: Domain): { members: string[]; opaque: boolean } {
    const members = new Set<string>()
    let opaque = false
    for (const evidence of domain?.values() ?? []) {
      for (const member of evidence.members) {
        members.add(member)
      }
      opaque ||= evidence.opaque
    }
    return { members: [...members].sort(), opaque }
  }
  private readDomain(sessionId: string, operationId?: string): Domain {
    const { store, journalDatabase } = this.host.deps
    const db = journalDatabase.db
    const domain: Domain = new Map()
    if (!operationId) {
      beginMailHistoryInventory(db, sessionId)
    }
    const local = resolveLineageRunningSession(conversationRecordReader(store), sessionId)
    for (const record of this.lineages.get(sessionId) ?? []) {
      const roots = this.roots.get(record)
      roots?.delete(sessionId)
      if (!roots?.size) {
        this.roots.delete(record)
      }
    }
    this.lineages.set(sessionId, local.lineage)
    for (const record of local.lineage) {
      const roots = this.roots.get(record) ?? new Set<string>()
      this.roots.set(record, roots)
      roots.add(sessionId)
    }
    const receipts = db
      .prepare(`SELECT operation_id FROM agent_session_command_receipts
      WHERE session_id = ? AND method = 'agentSession.send'
      AND caller_key LIKE 'trusted-local:orchestration:%'
      AND caller_key != 'trusted-local:orchestration:ordinary-mail'
      ${operationId ? 'AND operation_id = ?' : ''}`)
      .all(...(operationId ? [sessionId, operationId] : [sessionId]))
    const drafts = new Map<string, string>()
    const addBody = (id: string, json: unknown) => {
      const parsed = typeof json === 'string' ? parseJournalRow(json) : null
      const row = parsed?.ok ? parsed.row : null
      const body =
        row?.kind === 'submission'
          ? row.body
          : row?.kind === 'queue' && row.change.op === 'queued'
            ? row.change.body
            : null
      const mail = body?.from?.orchestration
      if (body && (!mail || mail.message !== 'mail-notice')) {
        return
      }
      domain.set(id, {
        members: new Set(
          local.kind === 'here'
            ? (mail?.messages.map((member) => mailMemberKey(member.runId, member.messageId)) ?? [])
            : []
        ),
        opaque: !mail || mail.messages.length === 0 || local.kind !== 'here'
      })
    }
    for (const saved of receipts) {
      if (typeof saved.operation_id !== 'string') {
        continue
      }
      const id = saved.operation_id
      const read = store.readCommandReceipt({ kind: 'global' }, id)
      if (read.verdict !== 'readable') {
        domain.set(id, { members: new Set(), opaque: true })
        continue
      }
      if (read.receipt.status !== 'accepted') {
        continue
      }
      const result = read.receipt.result
      observeMailHistoryReference(db, sessionId, result)
      if (result.kind === 'queued-draft') {
        drafts.set(result.messageId, id)
      } else if (result.kind === 'journal-row') {
        addBody(
          id,
          db
            .prepare(`SELECT row_json FROM journal_rows
          WHERE session_id = ? AND epoch = ? AND seq = ?`)
            .get(sessionId, result.epoch, result.sequence)?.row_json
        )
      } else {
        domain.set(id, { members: new Set(), opaque: true })
      }
    }
    if (drafts.size) {
      const rows = db
        .prepare(`SELECT row_json FROM journal_rows WHERE session_id = ?
        AND json_valid(row_json) AND json_extract(row_json, '$.kind') = 'queue'
        AND json_extract(row_json, '$.change.op') = 'queued'
        AND json_extract(row_json, '$.change.queuedAt.epoch') = epoch
        AND json_extract(row_json, '$.change.queuedAt.sequence') + 1 = seq
        ORDER BY epoch, seq`)
        .iterate(sessionId)
      for (const row of rows) {
        const parsed = typeof row.row_json === 'string' ? parseJournalRow(row.row_json) : null
        if (parsed?.ok && parsed.row.kind === 'queue') {
          const id = drafts.get(parsed.row.messageId)
          if (id) {
            addBody(id, row.row_json)
            drafts.delete(parsed.row.messageId)
          }
        }
      }
      for (const id of drafts.values()) {
        domain.set(id, { members: new Set(), opaque: true })
      }
    }
    return domain
  }
}
const histories = new WeakMap<StructuredAgentSessionHost, OriginalMailHistory>()
function originalHistory(host: StructuredAgentSessionHost): OriginalMailHistory {
  let history = histories.get(host)
  if (!history) {
    history = new OriginalMailHistory(host)
    histories.set(host, history)
  }
  return history
}
export function observeMailCreationHistory(
  host: StructuredAgentSessionHost,
  listener: (members: ReadonlySet<string>) => void
): () => void {
  return originalHistory(host).observe(listener)
}
export function forgetMailCreationHistorySource(
  host: StructuredAgentSessionHost,
  key: string
): void {
  histories.get(host)?.forget(key)
}
/** Retained original membership proves acceptance; mutable current card content never proves absence. */
export function readMailCreationHistory(
  host: StructuredAgentSessionHost,
  _sessionId: string,
  key?: string
): MailCreationHistory {
  return originalHistory(host).read(key)
}
