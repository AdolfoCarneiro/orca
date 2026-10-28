import { z } from 'zod'
import {
  ordinaryMailCreationId,
  type StructuredMailboxPointerHost
} from './structured-mailbox-pointer-delivery'
import {
  bindMailCreationProof,
  parseMailCreationProof,
  sameMailAuthority,
  recoverRunMailCreationProof
} from './db/messages/mail-creation-proof'
import type { Interest, SourceIdentity } from './structured-mail-source-discovery'
import { mailMemberKey } from './structured-mail-original-history'
export {
  readMailCreationHistory,
  observeMailCreationHistory,
  forgetMailCreationHistorySource,
  type MailCreationHistory
} from './structured-mail-original-history'
export function readSourceCreation(
  host: StructuredMailboxPointerHost,
  interest: Interest,
  source: SourceIdentity
): 'accepted' | 'absent' | 'unknown' {
  const canonical = host.readCreation(ordinaryMailCreationId(source), interest.target.sessionId)
  if (canonical !== 'absent') {
    return canonical
  }
  if (interest.db.hasColumn('messages', 'handoff')) {
    const hint = interest.db.db
      .prepare('SELECT handoff FROM messages WHERE id = ?')
      .get(source.id)?.handoff
    if (typeof hint === 'string') {
      const parsed = z
        .object({
          version: z.literal(1),
          kind: z.literal('structured'),
          operationId: z.string(),
          manifest: z.object({ members: z.array(z.string()) })
        })
        .safeParse(readHint(hint))
      if (
        parsed.success &&
        parsed.data.manifest.members.includes(source.id) &&
        host.readCreation(parsed.data.operationId, interest.target.sessionId, true) === 'accepted'
      ) {
        return 'accepted'
      }
    }
  }
  if (source.creation_proof === null) {
    recoverRunMailCreationProof(interest.db, source.id)
    const value = interest.db.db
      .prepare('SELECT creation_proof FROM messages WHERE id = ?')
      .get(source.id)?.creation_proof
    source.creation_proof = typeof value === 'string' ? value : null
  }
  const proof = parseMailCreationProof(source.creation_proof)
  const authority = host.creationAuthority?.() ?? null
  if (proof && authority) {
    if (proof.authority === 'unbound') {
      if (bindMailCreationProof(interest.db, source.id, authority)) {
        return 'absent'
      }
    } else if (sameMailAuthority(proof.authority, authority)) {
      return 'absent'
    }
  }
  const history = host.readHistory(
    interest.target.sessionId,
    mailMemberKey(source.run_id, source.id)
  )
  if (history.members.has(mailMemberKey(source.run_id, source.id))) {
    return 'accepted'
  }
  return 'unknown'
}
function readHint(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}
