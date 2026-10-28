import { z } from 'zod'
import type { OrchestrationDb } from '../orchestration-db'
import type Database from '../../../../sqlite/sync-database'
import type { MailCreationAuthority } from '../../../../native-chat/agent-session-journal/mail-creation-authority'
import { runLifecycleWriteTransaction } from '../lifecycle-write-transaction-runner'

const authoritySchema = z.strictObject({
  storeId: z.string().min(1),
  coverageToken: z.string().min(1)
})
const proofSchema = z.strictObject({
  version: z.literal(1),
  scheme: z.literal('ordinary-mail-v1'),
  authority: z.union([z.literal('unbound'), authoritySchema])
})
export const UNBOUND_MAIL_CREATION = JSON.stringify({
  version: 1,
  scheme: 'ordinary-mail-v1',
  authority: 'unbound'
})
export function parseMailCreationProof(value: unknown): z.infer<typeof proofSchema> | null {
  if (typeof value !== 'string') {
    return null
  }
  try {
    const parsed = proofSchema.safeParse(JSON.parse(value))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
export function sameMailAuthority(
  a: MailCreationAuthority | null,
  b: MailCreationAuthority | null
): boolean {
  return a !== null && b !== null && a.storeId === b.storeId && a.coverageToken === b.coverageToken
}
export function ensureMailCreationProofColumns(db: Database.Database): void {
  runLifecycleWriteTransaction(db, 'mail_creation_proofs', () => {
    for (const [table, column] of [
      ['messages', 'creation_proof'],
      ['runs', 'mail_creation_domain']
    ]) {
      if (
        !db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .some((row) => row.name === column)
      ) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`)
      }
    }
  })
}

/** Only an actual newly founded local Run and its authenticated home Dispatch qualify imports. */
export function homeImportCreationProof(
  db: OrchestrationDb,
  runId: string,
  dispatchId: string
): string | null {
  const dispatch = db.getDispatchContextById(dispatchId)
  const federated = db.getFederatedDispatch(dispatchId)
  if (dispatch?.run_id !== runId || !federated) {
    return null
  }
  const value = db.db
    .prepare('SELECT mail_creation_domain FROM runs WHERE id = ?')
    .get(runId)?.mail_creation_domain
  return parseMailCreationProof(value) && typeof value === 'string' ? value : null
}

/** Genuine local Run founding closes its canonical creation lifetime, including missed sources. */
export function runMailCreationProof(db: OrchestrationDb, runId: string): string | null {
  const value = db.db
    .prepare('SELECT mail_creation_domain FROM runs WHERE id = ?')
    .get(runId)?.mail_creation_domain
  return typeof value === 'string' && parseMailCreationProof(value) ? value : null
}
export function recoverRunMailCreationProof(db: OrchestrationDb, id: string): void {
  const row = db.db
    .prepare('SELECT run_id FROM messages WHERE id = ? AND creation_proof IS NULL')
    .get(id)
  const proof = typeof row?.run_id === 'string' ? runMailCreationProof(db, row.run_id) : null
  if (proof) {
    db.db
      .prepare('UPDATE messages SET creation_proof = ? WHERE id = ? AND creation_proof IS NULL')
      .run(proof, id)
  }
}

/** Binding commits before offer; a bound original domain is never silently rebound. */
export function bindMailCreationProof(
  db: OrchestrationDb,
  id: string,
  authority: MailCreationAuthority
): boolean {
  return runLifecycleWriteTransaction(db.db, 'bind_mail_creation', () => {
    const row = db.db.prepare('SELECT run_id, creation_proof FROM messages WHERE id = ?').get(id)
    const proof = parseMailCreationProof(row?.creation_proof)
    if (!proof || typeof row?.run_id !== 'string') {
      return false
    }
    if (proof.authority !== 'unbound') {
      return sameMailAuthority(proof.authority, authority)
    }
    const domainRow = db.db
      .prepare('SELECT mail_creation_domain FROM runs WHERE id = ?')
      .get(row?.run_id)
    const domain = parseMailCreationProof(domainRow?.mail_creation_domain)
    const bound = JSON.stringify({ ...proof, authority })
    if (domain?.authority === 'unbound') {
      db.db
        .prepare(
          'UPDATE runs SET mail_creation_domain = ? WHERE id = ? AND mail_creation_domain = ?'
        )
        .run(bound, row?.run_id, domainRow?.mail_creation_domain)
    }
    db.db
      .prepare('UPDATE messages SET creation_proof = ? WHERE id = ? AND creation_proof = ?')
      .run(bound, id, row?.creation_proof)
    return true
  })
}
