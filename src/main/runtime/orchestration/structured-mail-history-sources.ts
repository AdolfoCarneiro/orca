import { z } from 'zod'
import type { OrchestrationDb } from './db'
import type { StructuredMailboxPointerHost } from './structured-mail-creation-contract'

/** Original evidence follows the source identity even after its destination leaf changes. */
export class MailHistorySources {
  private owner: object | undefined
  private unsubscribe: (() => void) | undefined
  private readonly sources = new Map<string, string>()
  constructor(
    private readonly deps: {
      getDb: () => OrchestrationDb | null
      host: StructuredMailboxPointerHost
    },
    private readonly nominate: (mailbox: string, ids: readonly string[]) => void
  ) {}
  record(id: string, runId: string): void {
    this.sources.set(id, JSON.stringify([runId, id]))
  }
  forget(id: string): void {
    const key = this.sources.get(id)
    if (key) {
      this.deps.host.forgetHistorySource?.(key)
      this.sources.delete(id)
    }
  }
  reset(): void {
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.owner = undefined
    this.sources.clear()
  }
  observe(db: OrchestrationDb, owner: object): void {
    if (this.owner === owner) {
      return
    }
    this.unsubscribe?.()
    this.owner = owner
    this.unsubscribe = this.deps.host.observeHistory?.((members) => {
      if (this.deps.getDb() !== db) {
        return
      }
      for (const key of members) {
        const parsed = z.tuple([z.string(), z.string()]).safeParse(JSON.parse(key))
        if (!parsed.success) {
          continue
        }
        const [runId, id] = parsed.data
        const row = db.db
          .prepare('SELECT to_handle FROM messages WHERE id = ? AND run_id = ?')
          .get(id, runId)
        if (typeof row?.to_handle === 'string') {
          this.nominate(row.to_handle, [id])
        }
      }
    })
  }
}
