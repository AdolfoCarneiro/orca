import { isPluginJsonObject } from './manifest/plugin-json-object'

/**
 * postMessage protocol between a sandboxed custom editor frame and the editor tab hosting it.
 * The frame only ever sees the document's text: Orca keeps the buffer, dirty state, saving and
 * the file's location, so the plugin never learns a path or touches a file system.
 */

export const CUSTOM_EDITOR_READY_TYPE = 'orca-editor-ready'
export const CUSTOM_EDITOR_DOCUMENT_TYPE = 'orca-editor-document'
export const CUSTOM_EDITOR_EDIT_TYPE = 'orca-editor-edit'
export const CUSTOM_EDITOR_FLUSH_TYPE = 'orca-editor-flush'
export const CUSTOM_EDITOR_FLUSHED_TYPE = 'orca-editor-flushed'
/** Sent by the host shell, not plugin code: frame keys never reach Orca's own shortcut handlers. */
export const CUSTOM_EDITOR_KEYDOWN_TYPE = 'orca-editor-keydown'

/** Why this cap: it bounds one structured-clone edit while fitting scenes with embedded images. */
export const CUSTOM_EDITOR_DOCUMENT_MAX_BYTES = 16 * 1024 * 1024
/** Edits are full-text, so a debounced editor needs only a few per second. */
export const CUSTOM_EDITOR_EDIT_RATE_LIMIT = { maxMessages: 60, perMs: 10_000 }
/** How long a save waits for the frame to post an edit still in its debounce window. */
export const CUSTOM_EDITOR_FLUSH_TIMEOUT_MS = 1_000

export type CustomEditorDocumentMessage = {
  type: typeof CUSTOM_EDITOR_DOCUMENT_TYPE
  text: string
  readOnly: boolean
}

export type CustomEditorFlushMessage = {
  type: typeof CUSTOM_EDITOR_FLUSH_TYPE
  requestId: number
}

export type CustomEditorKeyChord = {
  key: string
  code: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

export type CustomEditorFrameMessage =
  | { type: typeof CUSTOM_EDITOR_READY_TYPE }
  | { type: typeof CUSTOM_EDITOR_EDIT_TYPE; text: string }
  | { type: typeof CUSTOM_EDITOR_FLUSHED_TYPE; requestId: number }
  | ({ type: typeof CUSTOM_EDITOR_KEYDOWN_TYPE } & CustomEditorKeyChord)

function shortString(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64
}

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
    case CUSTOM_EDITOR_EDIT_TYPE:
      return typeof message.text === 'string'
        ? { type: CUSTOM_EDITOR_EDIT_TYPE, text: message.text }
        : null
    case CUSTOM_EDITOR_FLUSHED_TYPE:
      return Number.isSafeInteger(message.requestId)
        ? { type: CUSTOM_EDITOR_FLUSHED_TYPE, requestId: Number(message.requestId) }
        : null
    case CUSTOM_EDITOR_KEYDOWN_TYPE:
      return shortString(message.key) && shortString(message.code)
        ? {
            type: CUSTOM_EDITOR_KEYDOWN_TYPE,
            key: message.key,
            code: message.code,
            metaKey: message.metaKey === true,
            ctrlKey: message.ctrlKey === true,
            altKey: message.altKey === true,
            shiftKey: message.shiftKey === true
          }
        : null
    default:
      return null
  }
}

/** Shell script for custom editor frames: forwards modifier chords so Orca's save shortcut works. */
export const CUSTOM_EDITOR_SHELL_SCRIPT =
  "window.addEventListener('keydown', function (event) {\n" +
  '  if (event.repeat || !(event.metaKey || event.ctrlKey)) return\n' +
  '  window.parent.postMessage({\n' +
  `    type: '${CUSTOM_EDITOR_KEYDOWN_TYPE}', key: String(event.key).slice(0, 64),\n` +
  '    code: String(event.code).slice(0, 64), metaKey: event.metaKey, ctrlKey: event.ctrlKey,\n' +
  '    altKey: event.altKey, shiftKey: event.shiftKey\n' +
  "  }, '*')\n" +
  '}, true)\n'
