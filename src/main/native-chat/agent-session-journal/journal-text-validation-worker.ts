import Database from '../../sqlite/sync-database'
import {
  readJournalTextRow,
  validateJournalTextRow,
  type JournalTextValidationRequest,
  type JournalTextValidationResponse
} from './journal-text-validation'

export function handleJournalTextValidation(
  request: JournalTextValidationRequest
): JournalTextValidationResponse {
  try {
    const db = new Database(request.dbPath, { readonly: true, fileMustExist: true, timeout: 250 })
    try {
      const json = readJournalTextRow(db, request.query)
      return {
        id: request.id,
        ok: true,
        proof: validateJournalTextRow(json, request.query),
        bytes: Buffer.byteLength(json)
      }
    } finally {
      db.close()
    }
  } catch (error) {
    return {
      id: request.id,
      ok: false,
      error: String(error),
      ...(error instanceof Error && error.message.startsWith('journal_text_prune_row_')
        ? {}
        : { unavailable: true as const })
    }
  }
}
