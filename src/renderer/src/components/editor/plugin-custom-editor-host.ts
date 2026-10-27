import {
  CUSTOM_EDITOR_DOCUMENT_MAX_BYTES,
  CUSTOM_EDITOR_DOCUMENT_TYPE,
  CUSTOM_EDITOR_EDIT_RATE_LIMIT,
  CUSTOM_EDITOR_FLUSH_TIMEOUT_MS,
  CUSTOM_EDITOR_FLUSH_TYPE,
  isCustomEditorEditAttempt,
  readCustomEditorFrameMessage,
  customEditorConflict,
  type CustomEditorDocumentMessage,
  type CustomEditorEditRejectedMessage,
  type CustomEditorKeyChord
} from '../../../../shared/plugins/plugin-custom-editor-bridge'
import { readPanelPongId } from '../../../../shared/plugins/plugin-panel-bridge'
import {
  createPanelMessageBudget,
  structuredCloneMessageBytes,
  type PanelMessageBudget
} from '../../../../shared/plugins/plugin-panel-message-budget'

export type CustomEditorEditRefusal = 'oversized' | 'rate_limited'

/** A binary editor's loaded file; a new object means new bytes to send. */
export type CustomEditorBinaryDocument = { bytes: Uint8Array<ArrayBuffer>; fileType: string }

export type CustomEditorHostOptions = {
  getFrameWindow: () => Window | null
  /** The buffer as Orca holds it now. */
  getDocument: () => { text: string; readOnly: boolean }
  /** Binary editors only: the file's bytes, or null while they load. Its edits are never applied. */
  getBinaryDocument?: () => CustomEditorBinaryDocument | null
  onEdit: (text: string) => void
  onEditRefused?: (reason: CustomEditorEditRefusal) => void
  onKeyChord?: (chord: CustomEditorKeyChord) => void
  onPong?: (pingId: number) => void
  budget?: PanelMessageBudget
  now?: () => number
  flushTimeoutMs?: number
}

export type CustomEditorHost = {
  handleMessage: (event: MessageEvent) => void
  /** Push the buffer when it changed outside the frame (reload, revert, Source edits). */
  syncDocument: () => void
  /** Resolves once the frame posted edits still in its debounce window, or on timeout. */
  flush: () => Promise<void>
  /** The newest text either side holds: the frame's last edit or the buffer last sent. */
  currentText: () => string
  /** A new document mounted in the frame; it must announce ready again. */
  reset: () => void
}

/** The frame only ever holds text: Orca owns the buffer, dirty state and save. */
export function createCustomEditorHost(options: CustomEditorHostOptions): CustomEditorHost {
  const budget =
    options.budget ??
    createPanelMessageBudget({
      maxBytes: CUSTOM_EDITOR_DOCUMENT_MAX_BYTES,
      ...CUSTOM_EDITOR_EDIT_RATE_LIMIT
    })
  const now = options.now ?? (() => Date.now())
  const flushTimeoutMs = options.flushTimeoutMs ?? CUSTOM_EDITOR_FLUSH_TIMEOUT_MS
  let ready = false
  // What the frame is known to hold, so its own edits are never echoed back.
  let frameText: string | null = null
  let frameReadOnly: boolean | null = null
  let frameBinary: CustomEditorBinaryDocument | null = null
  // The version of the last document sent; edits against an older one are refused.
  let version = 0
  let nextFlushId = 0
  const pendingFlushes = new Map<number, () => void>()

  const post = (
    message:
      | CustomEditorDocumentMessage
      | CustomEditorEditRejectedMessage
      | { type: string; requestId: number },
    transfer: Transferable[] = []
  ) => {
    // Opaque srcdoc origins require targetOrigin '*'.
    options.getFrameWindow()?.postMessage(message, '*', transfer)
  }

  const pushBinaryDocument = (force: boolean, binary: CustomEditorBinaryDocument | null): void => {
    if (!binary || (!force && binary === frameBinary)) {
      return
    }
    frameBinary = binary
    // Why a copy: transferring detaches the buffer, and a remounted frame needs the bytes again.
    const bytes = binary.bytes.slice().buffer
    version += 1
    post(
      {
        type: CUSTOM_EDITOR_DOCUMENT_TYPE,
        version,
        readOnly: true,
        fileType: binary.fileType,
        content: { kind: 'bytes', bytes }
      },
      [bytes]
    )
  }

  const pushDocument = (force: boolean): void => {
    if (!ready) {
      return
    }
    if (options.getBinaryDocument) {
      pushBinaryDocument(force, options.getBinaryDocument())
      return
    }
    const { text, readOnly } = options.getDocument()
    if (!force && text === frameText && readOnly === frameReadOnly) {
      return
    }
    frameText = text
    frameReadOnly = readOnly
    version += 1
    post({
      type: CUSTOM_EDITOR_DOCUMENT_TYPE,
      version,
      readOnly,
      content: { kind: 'text', text }
    })
  }

  const settleFlushes = (): void => {
    for (const settle of pendingFlushes.values()) {
      settle()
    }
    pendingFlushes.clear()
  }

  return {
    handleMessage(event) {
      const frameWindow = options.getFrameWindow()
      // Sandboxed srcdoc has a null origin; trust the sending Window identity instead.
      if (!frameWindow || event.source !== frameWindow) {
        return
      }
      const pongId = readPanelPongId(event.data)
      if (pongId !== null) {
        options.onPong?.(pongId)
        return
      }
      // Budget before parsing so floods cannot spend unmetered validation work.
      const refusal = budget.admit(
        now(),
        structuredCloneMessageBytes(event.data, CUSTOM_EDITOR_DOCUMENT_MAX_BYTES)
      )
      if (refusal) {
        if (isCustomEditorEditAttempt(event.data)) {
          options.onEditRefused?.(refusal)
        }
        return
      }
      const message = readCustomEditorFrameMessage(event.data)
      if (!message) {
        return
      }
      switch (message.type) {
        case 'orca-editor-ready':
          ready = true
          pushDocument(true)
          return
        case 'orca-editor-edit': {
          const { readOnly } = options.getDocument()
          if (!ready || readOnly || options.getBinaryDocument) {
            return
          }
          if (message.baseVersion !== version) {
            post(customEditorConflict(message.baseVersion))
            return
          }
          if (message.text === frameText) {
            return
          }
          frameText = message.text
          options.onEdit(message.text)
          return
        }
        case 'orca-editor-flushed':
          pendingFlushes.get(message.requestId)?.()
          pendingFlushes.delete(message.requestId)
          return
        case 'orca-editor-keydown':
          options.onKeyChord?.(message)
      }
    },
    syncDocument() {
      pushDocument(false)
    },
    flush() {
      if (!ready) {
        return Promise.resolve()
      }
      const requestId = nextFlushId++
      return new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          pendingFlushes.delete(requestId)
          resolve()
        }, flushTimeoutMs)
        pendingFlushes.set(requestId, () => {
          clearTimeout(timer)
          resolve()
        })
        post({ type: CUSTOM_EDITOR_FLUSH_TYPE, requestId })
      })
    },
    currentText() {
      return frameText ?? options.getDocument().text
    },
    reset() {
      ready = false
      frameText = null
      frameReadOnly = null
      frameBinary = null
      settleFlushes()
    }
  }
}
