import type Database from '../../sqlite/sync-database'
import type { CommandReceiptResult } from '../../native-chat/agent-session-journal/command-receipt-schema'

type Change = { sessionId: string; operationId: string | null }
type HistoryRevision = {
  value: number
  effects: Map<string, Set<string>>
  listeners: Set<(changes: readonly Change[]) => void>
  flush: () => void
  cancelRetry: () => void
}
const revisions = new WeakMap<Database.Database, HistoryRevision>()
const point = (epoch: unknown, sequence: unknown) => JSON.stringify([epoch, sequence])

/** Transactional original-domain invalidation; unrelated records never change target admission. */
export function mailHistoryRevision(db: Database.Database): number {
  let revision = revisions.get(db)
  if (!revision) {
    let scheduled = false
    let retry: ReturnType<typeof setTimeout> | undefined
    const current: HistoryRevision = {
      value: 0,
      effects: new Map(),
      listeners: new Set(),
      flush: () => {},
      cancelRetry: () => {
        clearTimeout(retry)
        retry = undefined
      }
    }
    const schedule = () => {
      if (!scheduled) {
        scheduled = true
        queueMicrotask(() => {
          scheduled = false
          try {
            current.flush()
          } catch (error) {
            console.warn('[orchestration] original mail evidence notification pending', error)
            if (!retry && current.listeners.size) {
              retry = setTimeout(() => {
                retry = undefined
                schedule()
              }, 100)
              retry.unref()
            }
          }
        })
      }
      return 0
    }
    current.flush = () => {
      if (db.isTransaction || current.listeners.size === 0) {
        return
      }
      const rows = db
        .prepare('SELECT rowid, session_id, operation_id FROM mail_history_changes')
        .all()
      if (!rows.length) {
        return
      }
      const changes = rows.flatMap((row) =>
        typeof row.session_id === 'string'
          ? [
              {
                sessionId: row.session_id,
                operationId:
                  typeof row.operation_id === 'string' && row.operation_id !== ''
                    ? row.operation_id
                    : null
              }
            ]
          : []
      )
      for (const listener of current.listeners) {
        listener(changes)
      }
      db.prepare('DELETE FROM mail_history_changes WHERE rowid <= ?').run(rows.at(-1)?.rowid)
      current.value++
    }
    db.function('nominate_mail_history', {}, schedule)
    db.function('mail_history_row_changed', {}, (session, epoch, sequence, messageId) => {
      const keys = typeof session === 'string' ? current.effects.get(session) : undefined
      if (
        typeof session === 'string' &&
        (keys?.has(point(epoch, sequence)) ||
          (typeof messageId === 'string' && keys?.has(point('draft', messageId))))
      ) {
        schedule()
        return 1
      }
      return 0
    })
    db.exec(
      'CREATE TEMP TABLE mail_history_changes (session_id TEXT NOT NULL, operation_id TEXT NOT NULL, UNIQUE(session_id, operation_id))'
    )
    for (const event of ['INSERT', 'UPDATE', 'DELETE']) {
      const row = event === 'DELETE' ? 'OLD' : 'NEW'
      const receipt = (
        prefix: string
      ) => `INSERT OR IGNORE INTO mail_history_changes SELECT ${prefix}.session_id, ${prefix}.operation_id
        WHERE ${prefix}.caller_key LIKE 'trusted-local:orchestration:%'
        AND ${prefix}.caller_key != 'trusted-local:orchestration:ordinary-mail';`
      db.exec(`CREATE TEMP TRIGGER invalidate_mail_receipt_${event.toLowerCase()}
        AFTER ${event} ON main.agent_session_command_receipts BEGIN
        ${event === 'UPDATE' ? receipt('OLD') : ''} ${receipt(row)} SELECT nominate_mail_history(); END;`)
      const changed = (
        prefix: string
      ) => `INSERT OR IGNORE INTO mail_history_changes SELECT ${prefix}.session_id, '' WHERE mail_history_row_changed(
        ${prefix}.session_id, ${prefix}.epoch, ${prefix}.seq,
        CASE WHEN json_valid(${prefix}.row_json) THEN
          CASE WHEN json_extract(${prefix}.row_json, '$.kind') = 'queue'
            AND json_extract(${prefix}.row_json, '$.change.op') = 'queued'
            AND json_extract(${prefix}.row_json, '$.change.queuedAt.epoch') = ${prefix}.epoch
            AND json_extract(${prefix}.row_json, '$.change.queuedAt.sequence') + 1 = ${prefix}.seq
            THEN json_extract(${prefix}.row_json, '$.messageId') END END);`
      db.exec(`CREATE TEMP TRIGGER invalidate_mail_body_${event.toLowerCase()}
        AFTER ${event} ON main.journal_rows BEGIN
          ${event === 'UPDATE' ? changed('OLD') : ''} ${changed(row)} END;`)
      db.exec(`CREATE TEMP TRIGGER invalidate_mail_record_${event.toLowerCase()}
        AFTER ${event} ON main.agent_session_records
        ${event === 'UPDATE' ? "WHEN json_extract(CASE WHEN json_valid(OLD.record_json) THEN OLD.record_json ELSE '{}' END, '$.location') IS NOT json_extract(CASE WHEN json_valid(NEW.record_json) THEN NEW.record_json ELSE '{}' END, '$.location') OR json_extract(CASE WHEN json_valid(OLD.record_json) THEN OLD.record_json ELSE '{}' END, '$.conversationCommand') IS NOT json_extract(CASE WHEN json_valid(NEW.record_json) THEN NEW.record_json ELSE '{}' END, '$.conversationCommand')" : ''}
        BEGIN INSERT OR IGNORE INTO mail_history_changes VALUES (${row}.session_id, ''); SELECT nominate_mail_history(); END;`)
    }
    revisions.set(db, current)
    revision = current
  }
  return revision.value
}
export function observeMailHistoryChanges(
  db: Database.Database,
  listener: (changes: readonly Change[]) => void
): () => void {
  mailHistoryRevision(db)
  revisions.get(db)!.listeners.add(listener)
  return () => {
    const revision = revisions.get(db)
    revision?.listeners.delete(listener)
    if (!revision?.listeners.size) {
      revision?.cancelRetry()
    }
  }
}
export function flushMailHistoryChanges(db: Database.Database): void {
  revisions.get(db)?.flush()
}
export function beginMailHistoryInventory(db: Database.Database, sessionId?: string): void {
  mailHistoryRevision(db)
  if (sessionId) {
    revisions.get(db)?.effects.delete(sessionId)
  }
}
export function observeMailHistoryReference(
  db: Database.Database,
  sessionId: string,
  result: CommandReceiptResult
): void {
  const revision = revisions.get(db)
  if (!revision) {
    return
  }
  const keys = revision.effects.get(sessionId) ?? new Set<string>()
  revision.effects.set(sessionId, keys)
  if (result.kind === 'journal-row') {
    keys.add(point(result.epoch, result.sequence))
  }
  if (result.kind === 'queued-draft') {
    keys.add(point('draft', result.messageId))
  }
}
