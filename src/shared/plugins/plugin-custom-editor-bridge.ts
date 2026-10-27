import { isPluginJsonObject } from './manifest/plugin-json-object'

/**
 * postMessage protocol between a sandboxed custom editor frame and the editor tab hosting it.
 * Key chords never travel this channel: main reads them from real input (see
 * plugin-editor-guest-policy.ts), so editor code cannot trigger a save.
 * The frame only ever sees the document's text, or its bytes for a binary editor: Orca keeps the
 * buffer, dirty state, saving and the file's location, so the plugin never learns a path or
 * touches a file system.
 */

export const CUSTOM_EDITOR_READY_TYPE = 'orca-editor-ready'
export const CUSTOM_EDITOR_DOCUMENT_TYPE = 'orca-editor-document'
export const CUSTOM_EDITOR_EDIT_TYPE = 'orca-editor-edit'
export const CUSTOM_EDITOR_FLUSH_TYPE = 'orca-editor-flush'
export const CUSTOM_EDITOR_FLUSHED_TYPE = 'orca-editor-flushed'
/** Host reply to an edit made against a document version Orca has since replaced. */
export const CUSTOM_EDITOR_EDIT_REJECTED_TYPE = 'orca-editor-edit-rejected'

/** Why this cap: it bounds one structured-clone edit while fitting scenes with embedded images. */
export const CUSTOM_EDITOR_DOCUMENT_MAX_BYTES = 16 * 1024 * 1024
/** Edits are full-text, so a debounced editor needs only a few per second. */
export const CUSTOM_EDITOR_EDIT_RATE_LIMIT = { maxMessages: 60, perMs: 10_000 }
/** How long a save waits for the frame to post an edit still in its debounce window. */
export const CUSTOM_EDITOR_FLUSH_TIMEOUT_MS = 1_000

/** `bytes` is a transferred ArrayBuffer, never base64. */
export type CustomEditorContent =
  | { kind: 'text'; text: string }
  | { kind: 'bytes'; bytes: ArrayBuffer }

export type CustomEditorDocumentMessage = {
  type: typeof CUSTOM_EDITOR_DOCUMENT_TYPE
  /** Rises each time Orca sends a document; an edit names the version it was made against. */
  version: number
  readOnly: boolean
  content: CustomEditorContent
  /** Bytes documents: the manifest suffix that matched, e.g. `xlsx`; never a path or file name. */
  fileType?: string
}

export function customEditorConflict(baseVersion: number): CustomEditorEditRejectedMessage {
  return {
    type: CUSTOM_EDITOR_EDIT_REJECTED_TYPE,
    baseVersion,
    error: {
      code: 'conflict',
      message: 'The file changed outside this editor; edit the latest document.',
      retryable: true
    }
  }
}

export function customEditorTooLarge(baseVersion: number): CustomEditorEditRejectedMessage {
  return {
    type: CUSTOM_EDITOR_EDIT_REJECTED_TYPE,
    baseVersion,
    error: {
      code: 'too_large',
      message: 'The edit is larger than Orca accepts; the file keeps its last accepted text.',
      retryable: false
    }
  }
}

/** `code` is open-ended: editors must treat an unknown code as a failed edit. */
export type CustomEditorEditRejectedMessage = {
  type: typeof CUSTOM_EDITOR_EDIT_REJECTED_TYPE
  baseVersion: number
  error: { code: 'conflict' | 'too_large'; message: string; retryable: boolean }
}

export type CustomEditorFlushMessage = {
  type: typeof CUSTOM_EDITOR_FLUSH_TYPE
  requestId: number
}

export type CustomEditorFrameMessage =
  | { type: typeof CUSTOM_EDITOR_READY_TYPE }
  | { type: typeof CUSTOM_EDITOR_EDIT_TYPE; text: string; baseVersion: number }
  | { type: typeof CUSTOM_EDITOR_FLUSHED_TYPE; requestId: number }

/** Whether a frame message claims to be an edit, read before it is admitted. */
export function isCustomEditorEditAttempt(data: unknown): boolean {
  return isPluginJsonObject(data) && data.type === CUSTOM_EDITOR_EDIT_TYPE
}

/** Reads a frame message without throwing; null for anything outside the protocol. */
export function readCustomEditorFrameMessage(data: unknown): CustomEditorFrameMessage | null {
  if (!isPluginJsonObject(data)) {
    return null
  }
  const message = data
  switch (message.type) {
    case CUSTOM_EDITOR_READY_TYPE:
      return { type: CUSTOM_EDITOR_READY_TYPE }
    case CUSTOM_EDITOR_EDIT_TYPE: {
      // Why required: an edit that names no version could silently overwrite an outside change.
      const content = isPluginJsonObject(message.content) ? message.content : null
      if (
        content?.kind !== 'text' ||
        typeof content.text !== 'string' ||
        !Number.isSafeInteger(message.baseVersion)
      ) {
        return null
      }
      return {
        type: CUSTOM_EDITOR_EDIT_TYPE,
        text: content.text,
        baseVersion: Number(message.baseVersion)
      }
    }
    case CUSTOM_EDITOR_FLUSHED_TYPE:
      return Number.isSafeInteger(message.requestId)
        ? { type: CUSTOM_EDITOR_FLUSHED_TYPE, requestId: Number(message.requestId) }
        : null
    default:
      return null
  }
}
