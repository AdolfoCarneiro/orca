import { randomUUID } from 'node:crypto'
import { createStructuredAgentSessionOperationId } from '../../../shared/structured-agent-session-mutation'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { MailCreationAuthority } from '../agent-session-journal/mail-creation-authority'

type Birth = { epoch: string; authority: MailCreationAuthority; used: boolean; claimed: boolean }
const births = new WeakMap<AgentSessionJournal, Map<string, Birth>>()
const sameAuthority = (a: MailCreationAuthority, b: MailCreationAuthority | null) =>
  a.storeId === b?.storeId && a.coverageToken === b.coverageToken

/** The ordinary consume owner actually mints this identity; a supplied/replayed ID cannot enter. */
export function allocateQueuedSubmission(journal: AgentSessionJournal): string {
  const id = createStructuredAgentSessionOperationId(randomUUID)
  const authority = journal.requestBirthAuthority()
  if (authority) {
    const entries = births.get(journal) ?? new Map<string, Birth>()
    births.set(journal, entries)
    entries.set(id, { epoch: journal.epoch, authority, used: false, claimed: false })
  }
  return id
}
export function hasSubmissionBirths(journal: AgentSessionJournal): boolean {
  return Boolean(births.get(journal)?.size)
}
export function forgetSubmissionBirths(journal: AgentSessionJournal): void {
  births.delete(journal)
}
export function retireSubmissionBirth(journal: AgentSessionJournal, id: string): void {
  const entries = births.get(journal)
  if (!entries?.get(id)?.claimed) {
    entries?.delete(id)
  }
}
export function submissionBirth(
  journal: AgentSessionJournal,
  id: string
):
  | {
      valid: () => boolean
      consume: () => void
    }
  | undefined {
  const entries = births.get(journal)
  const birth = entries?.get(id)
  if (!birth || birth.claimed) {
    return undefined
  }
  birth.claimed = true
  return {
    valid: () =>
      births.get(journal) === entries &&
      entries?.get(id) === birth &&
      !birth.used &&
      journal.epoch === birth.epoch &&
      sameAuthority(birth.authority, journal.requestBirthAuthority()),
    consume: () => {
      birth.used = true
      entries?.delete(id)
    }
  }
}
