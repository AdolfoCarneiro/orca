import { AGENT_CHAT_PERMISSION_MODE_OPTION_ID } from './agent-chat-permission-mode'

/** Picks still on their way to the host, by option. Each write bumps the generation, so an older reply or read never overwrites a newer pick. */
export type StructuredOptionPickBook = {
  pending: Record<string, string>
  generation: number
  /** The agent's permission report as last seen, and the one the latest mode pick was made over. */
  permissionReport: string | null
  permissionPickedOver: string | null
}

export type StructuredOptionPick = { id: string; encoded: string; generation: number }

export function createStructuredOptionPickBook(): StructuredOptionPickBook {
  return { pending: {}, generation: 0, permissionReport: null, permissionPickedOver: null }
}

/** A new session or fence: replies to earlier picks no longer apply. */
export function resetStructuredOptionPickBook(book: StructuredOptionPickBook): void {
  book.generation += 1
  book.pending = {}
  book.permissionPickedOver = null
}

/** A different report is the agent's answer to the pick, whether or not it took it. */
export function observeStructuredPermissionReport(
  book: StructuredOptionPickBook,
  reportKey: string | null
): void {
  book.permissionReport = reportKey
  if (book.permissionPickedOver !== reportKey) {
    book.permissionPickedOver = null
  }
}

/** `shownAtOnce` picks are committed before the write, so they hold nothing pending. */
export function beginStructuredOptionPick(
  book: StructuredOptionPickBook,
  id: string,
  encoded: string,
  shownAtOnce: boolean
): StructuredOptionPick {
  if (!shownAtOnce) {
    book.pending[id] = encoded
  }
  if (id === AGENT_CHAT_PERMISSION_MODE_OPTION_ID) {
    book.permissionPickedOver = book.permissionReport
  }
  book.generation += 1
  return { id, encoded, generation: book.generation }
}

export function isLatestStructuredOptionPick(
  book: StructuredOptionPickBook,
  pick: StructuredOptionPick
): boolean {
  return book.generation === pick.generation
}

/** What an accepted reply commits: everything it returned for the latest write, only its own option when another option was picked since, nothing once this option was picked again. */
export function structuredOptionPickCommit(
  book: StructuredOptionPickBook,
  pick: StructuredOptionPick,
  returned: Readonly<Record<string, string>> | undefined
): Record<string, string> | null {
  const values = returned ?? { [pick.id]: pick.encoded }
  if (isLatestStructuredOptionPick(book, pick)) {
    return { ...values }
  }
  return book.pending[pick.id] === pick.encoded
    ? { [pick.id]: values[pick.id] ?? pick.encoded }
    : null
}

/** A refused mode pick no longer stands in for the agent's report. */
export function settleStructuredOptionPick(
  book: StructuredOptionPickBook,
  pick: StructuredOptionPick,
  accepted = true
): void {
  if (book.pending[pick.id] === pick.encoded) {
    delete book.pending[pick.id]
  }
  if (
    !accepted &&
    pick.id === AGENT_CHAT_PERMISSION_MODE_OPTION_ID &&
    isLatestStructuredOptionPick(book, pick)
  ) {
    book.permissionPickedOver = null
  }
}

export function structuredOptionPickIsPending(book: StructuredOptionPickBook, id: string): boolean {
  return book.pending[id] !== undefined
}

/** The pick a new one of `id` must wait for: a repeat waits, other options go together, and a starting provider holds nothing. */
export function structuredOptionPickBlockingId(
  book: StructuredOptionPickBook,
  id: string,
  providerStarting: boolean
): string | null {
  return !providerStarting && structuredOptionPickIsPending(book, id) ? id : null
}
