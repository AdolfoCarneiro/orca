import {
  CUSTOM_EDITOR_DOCUMENT_MAX_BYTES,
  CUSTOM_EDITOR_DOCUMENT_TYPE,
  CUSTOM_EDITOR_EDIT_RATE_LIMIT,
  CUSTOM_EDITOR_FLUSH_TIMEOUT_MS,
  CUSTOM_EDITOR_FLUSH_TYPE,
  isCustomEditorEditAttempt,
  readCustomEditorFrameMessage,
  customEditorConflict,
  customEditorTooLarge,
  type CustomEditorDocumentMessage,
  type CustomEditorEditRejectedMessage
} from '../../../../shared/plugins/plugin-custom-editor-bridge'
import { isPluginJsonObject } from '../../../../shared/plugins/manifest/plugin-json-object'
import { readPanelPongId } from '../../../../shared/plugins/plugin-panel-bridge'
import {
  createPanelMessageBudget,
  structuredCloneMessageBytes,
  type PanelMessageBudget
} from '../../../../shared/plugins/plugin-panel-message-budget'

export type CustomEditorEditRefusal = 'oversized' | 'rate_limited'

/** Why an edit has not reached the buffer: held for the rate limit, or lost for size. */
export type CustomEditorUnappliedEdit = 'held' | 'lost' | null

/** A binary editor's loaded file; a new object means new bytes to send. */
export type CustomEditorBinaryDocument = { bytes: Uint8Array<ArrayBuffer>; fileType: string }

export type CustomEditorHostOptions = {
  /** Delivers a message to the editor guest; `transfer` moves byte buffers instead of copying. */
  post: (message: unknown, transfer: Transferable[]) => void
  /** The buffer as Orca holds it now. */
  getDocument: () => { text: string; readOnly: boolean }
  /** A viewer per its installed manifest: its edits are refused even on a writable tab. */
  editorReadOnly?: boolean
  /** Binary editors only: the file's bytes, or null while they load. Its edits are never applied. */
  getBinaryDocument?: () => CustomEditorBinaryDocument | null
  onEdit: (text: string) => void
  onEditRefused?: (reason: CustomEditorEditRefusal) => void
  /** The frame holds edits the buffer lacks, or caught up again. */
  onUnappliedEdit?: (state: CustomEditorUnappliedEdit) => void
  onPong?: (pingId: number) => void
  budget?: PanelMessageBudget
  /** Meters non-edit messages, so chords and flush replies never spend the edit budget. */
  controlBudget?: PanelMessageBudget
  now?: () => number
  flushTimeoutMs?: number
}

export type CustomEditorHost = {
  /** A message the guest posted; main already routed it to this tab's guest. */
  handleMessage: (data: unknown) => void
  /** Push the buffer when it changed outside the frame (reload, revert, Source edits). */
  syncDocument: () => void
  /** Waits for edits still in the frame's debounce window; false on timeout or when an edit
   *  never reached the buffer, so a save must not mark the tab clean. */
  flush: () => Promise<boolean>
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
  const controlBudget = options.controlBudget ?? createPanelMessageBudget()
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
  // The newest edit refused for the rate limit, unparsed until applied; full-text, so it wins.
  let heldEdit: unknown = null
  let heldTimer: ReturnType<typeof setTimeout> | null = null
  let lostEdit = false
  let unapplied: CustomEditorUnappliedEdit = null

  const reportUnapplied = (): void => {
    const next = lostEdit ? 'lost' : heldEdit !== null ? 'held' : null
    if (next !== unapplied) {
      unapplied = next
      options.onUnappliedEdit?.(next)
    }
  }

  const post = (
    message:
      | CustomEditorDocumentMessage
      | CustomEditorEditRejectedMessage
      | { type: string; requestId: number },
    transfer: Transferable[] = []
  ) => {
    options.post(message, transfer)
  }
  const readOnly = (): boolean => options.editorReadOnly === true || options.getDocument().readOnly

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
    const { text } = options.getDocument()
    const documentReadOnly = readOnly()
    if (!force && text === frameText && documentReadOnly === frameReadOnly) {
      return
    }
    frameText = text
    frameReadOnly = documentReadOnly
    version += 1
    post({
      type: CUSTOM_EDITOR_DOCUMENT_TYPE,
      version,
      readOnly: documentReadOnly,
      content: { kind: 'text', text }
    })
  }

  const applyEdit = (text: string, baseVersion: number): void => {
    if (!ready || readOnly() || options.getBinaryDocument) {
      return
    }
    if (baseVersion !== version) {
      post(customEditorConflict(baseVersion))
      return
    }
    // A newer full text supersedes anything held back or lost.
    lostEdit = false
    reportUnapplied()
    if (text === frameText) {
      return
    }
    frameText = text
    options.onEdit(text)
  }

  const applyHeldEdit = (): void => {
    if (heldTimer !== null) {
      clearTimeout(heldTimer)
      heldTimer = null
    }
    const held = heldEdit
    heldEdit = null
    const message = held === null ? null : readCustomEditorFrameMessage(held)
    if (message?.type === 'orca-editor-edit') {
      applyEdit(message.text, message.baseVersion)
    }
    reportUnapplied()
  }

  const refuseEdit = (data: unknown, refusal: CustomEditorEditRefusal): void => {
    if (readOnly() || options.getBinaryDocument) {
      return
    }
    options.onEditRefused?.(refusal)
    if (refusal === 'oversized') {
      heldEdit = null
      lostEdit = true
      const baseVersion = isPluginJsonObject(data) ? data.baseVersion : undefined
      post(customEditorTooLarge(Number.isSafeInteger(baseVersion) ? Number(baseVersion) : version))
    } else {
      heldEdit = data
      heldTimer ??= setTimeout(applyHeldEdit, CUSTOM_EDITOR_EDIT_RATE_LIMIT.perMs)
    }
    reportUnapplied()
  }

  const settleFlushes = (): void => {
    for (const settle of pendingFlushes.values()) {
      settle()
    }
    pendingFlushes.clear()
  }

  return {
    handleMessage(data) {
      const pongId = readPanelPongId(data)
      if (pongId !== null) {
        options.onPong?.(pongId)
        return
      }
      // Budget before parsing so floods cannot spend unmetered validation work.
      const isEdit = isCustomEditorEditAttempt(data)
      const refusal = (isEdit ? budget : controlBudget).admit(
        now(),
        structuredCloneMessageBytes(data, CUSTOM_EDITOR_DOCUMENT_MAX_BYTES)
      )
      if (refusal) {
        if (isEdit) {
          refuseEdit(data, refusal)
        }
        return
      }
      const message = readCustomEditorFrameMessage(data)
      if (!message) {
        return
      }
      switch (message.type) {
        case 'orca-editor-ready':
          ready = true
          pushDocument(true)
          return
        case 'orca-editor-edit':
          // An admitted edit is newer than any held one.
          heldEdit = null
          applyEdit(message.text, message.baseVersion)
          reportUnapplied()
          return
        case 'orca-editor-flushed':
          pendingFlushes.get(message.requestId)?.()
          pendingFlushes.delete(message.requestId)
      }
    },
    syncDocument() {
      pushDocument(false)
    },
    flush() {
      if (!ready) {
        return Promise.resolve(!lostEdit)
      }
      const requestId = nextFlushId++
      return new Promise<boolean>((resolve) => {
        const settle = (answered: boolean): void => {
          pendingFlushes.delete(requestId)
          // A save applies the newest held edit now instead of waiting out the rate limit.
          applyHeldEdit()
          resolve(answered && !lostEdit)
        }
        const timer = setTimeout(() => settle(false), flushTimeoutMs)
        pendingFlushes.set(requestId, () => {
          clearTimeout(timer)
          settle(true)
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
      heldEdit = null
      lostEdit = false
      if (heldTimer !== null) {
        clearTimeout(heldTimer)
        heldTimer = null
      }
      reportUnapplied()
      settleFlushes()
    }
  }
}
