import { SessionSourceReceipts } from '../lib/session-source-receipts'
import { SESSION_SOURCE_KINDS } from '../lib/session-source-fields'
import {
  readSessionSourceReceipt,
  withSessionSourceReceipt,
  type OrdinarySourcePartial,
  type SessionSourceWrite
} from './session-source-edits'

/** Only middleware may compose overlapping fields; it starts from the preceding write's result. */
export function composeSessionSourceWrites<S>(
  writes: (SessionSourceWrite<S> | OrdinarySourcePartial<S>)[],
  middlewareChain = false
): SessionSourceWrite<S> {
  const receipts = new SessionSourceReceipts()
  const fields = new Set<string>()
  for (const write of writes) {
    const receipt = readSessionSourceReceipt(write)
    for (const field of receipt?.changes.keys() ?? []) {
      if (
        import.meta.env.DEV &&
        !middlewareChain &&
        SESSION_SOURCE_KINDS[field] === 'keyed' &&
        fields.has(field)
      ) {
        throw new Error(`Composed source writes overlap: ${field}`)
      }
      fields.add(field)
    }
    if (receipt) {
      receipts.add(receipt)
    }
  }
  return withSessionSourceReceipt(Object.assign({}, ...writes), receipts.snapshot())
}
