import { describe, expect, it, vi } from 'vitest'
import {
  CUSTOM_EDITOR_DOCUMENT_MAX_BYTES,
  readCustomEditorFrameMessage
} from '../../../../shared/plugins/plugin-custom-editor-bridge'
import { isPluginJsonObject } from '../../../../shared/plugins/manifest/plugin-json-object'
import { createPanelMessageBudget } from '../../../../shared/plugins/plugin-panel-message-budget'
import { createCustomEditorHost } from './plugin-custom-editor-host'

const edit = (text: string, baseVersion = 1) => ({
  type: 'orca-editor-edit',
  baseVersion,
  content: { kind: 'text', text }
})

function setup(initial: {
  text: string
  readOnly?: boolean
  editorReadOnly?: boolean
  maxEdits?: number
}) {
  const posted: unknown[] = []
  const doc = { text: initial.text, readOnly: initial.readOnly ?? false }
  const onEdit = vi.fn((text: string) => {
    doc.text = text
  })
  const onEditRefused = vi.fn()
  const onUnappliedEdit = vi.fn()
  const host = createCustomEditorHost({
    post: (message) => posted.push(message),
    getDocument: () => doc,
    editorReadOnly: initial.editorReadOnly,
    onEdit,
    onEditRefused,
    onUnappliedEdit,
    flushTimeoutMs: 50,
    ...(initial.maxEdits === undefined
      ? {}
      : {
          budget: createPanelMessageBudget({
            maxBytes: CUSTOM_EDITOR_DOCUMENT_MAX_BYTES,
            maxMessages: initial.maxEdits,
            perMs: 60_000
          })
        })
  })
  const send = (data: unknown) => host.handleMessage(data)
  const answerFlushes = () => {
    for (const message of posted) {
      if (isPluginJsonObject(message) && message.type === 'orca-editor-flush') {
        send({ type: 'orca-editor-flushed', requestId: message.requestId })
      }
    }
  }
  return {
    host,
    posted,
    doc,
    onEdit,
    onEditRefused,
    onUnappliedEdit,
    send,
    answerFlushes
  }
}

function setupBytes() {
  const posted: { message: unknown; transfer: unknown }[] = []
  let binary: { bytes: Uint8Array<ArrayBuffer>; fileType: string } | null = null
  const onEdit = vi.fn()
  const host = createCustomEditorHost({
    post: (message, transfer) => posted.push({ message, transfer }),
    getDocument: () => ({ text: '', readOnly: true }),
    getBinaryDocument: () => binary,
    onEdit
  })
  const send = (data: unknown) => host.handleMessage(data)
  return {
    host,
    posted,
    onEdit,
    send,
    load: (bytes: number[]) => {
      binary = { bytes: new Uint8Array(bytes), fileType: 'xlsx' }
      return binary
    }
  }
}

describe('custom editor bytes documents', () => {
  it('waits for the bytes, then transfers a copy so a remounted frame can get them again', () => {
    const { host, posted, send, load } = setupBytes()
    send({ type: 'orca-editor-ready' })
    expect(posted).toEqual([])
    const loaded = load([0x50, 0x4b, 3, 4])
    host.syncDocument()
    expect(posted).toHaveLength(1)
    const [{ message, transfer }] = posted
    expect(message).toMatchObject({
      type: 'orca-editor-document',
      version: 1,
      readOnly: true,
      fileType: 'xlsx',
      content: { kind: 'bytes' }
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: shape asserted just above.
    const bytes = (message as { content: { bytes: ArrayBuffer } }).content.bytes
    expect(bytes).toBeInstanceOf(ArrayBuffer)
    expect([...new Uint8Array(bytes)]).toEqual([0x50, 0x4b, 3, 4])
    expect(transfer).toEqual([bytes])
    expect(bytes).not.toBe(loaded.bytes.buffer)
    host.syncDocument()
    expect(posted).toHaveLength(1)
  })

  it('sends new bytes with a higher version after an outside change', () => {
    const { host, posted, send, load } = setupBytes()
    load([1])
    send({ type: 'orca-editor-ready' })
    load([2])
    host.syncDocument()
    expect(posted.map(({ message }) => message)).toMatchObject([{ version: 1 }, { version: 2 }])
  })

  it('never applies an edit from a bytes editor', () => {
    const { onEdit, send, load } = setupBytes()
    load([1])
    send({ type: 'orca-editor-ready' })
    send({ type: 'orca-editor-edit', text: 'x' })
    send({ type: 'orca-editor-edit', baseVersion: 1, content: { kind: 'text', text: 'x' } })
    expect(onEdit).not.toHaveBeenCalled()
  })
})

describe('custom editor document versions', () => {
  it('applies an edit made against the current version', () => {
    const { onEdit, send } = setup({ text: 'a' })
    send({ type: 'orca-editor-ready' })
    send({ type: 'orca-editor-edit', baseVersion: 1, content: { kind: 'text', text: 'b' } })
    expect(onEdit).toHaveBeenCalledWith('b')
  })

  it('refuses a stale edit with a conflict instead of overwriting the outside change', () => {
    const { host, posted, doc, onEdit, send } = setup({ text: 'a' })
    send({ type: 'orca-editor-ready' })
    doc.text = 'changed on disk'
    host.syncDocument()
    send({ type: 'orca-editor-edit', baseVersion: 1, content: { kind: 'text', text: 'mine' } })
    expect(onEdit).not.toHaveBeenCalled()
    expect(posted.at(-1)).toEqual({
      type: 'orca-editor-edit-rejected',
      baseVersion: 1,
      error: { code: 'conflict', message: expect.any(String), retryable: true }
    })
  })

  it('drops an edit that names no version or uses the old top-level text', () => {
    const { onEdit, send } = setup({ text: 'a' })
    send({ type: 'orca-editor-ready' })
    send({ type: 'orca-editor-edit', text: 'legacy' })
    send({ type: 'orca-editor-edit', content: { kind: 'text', text: 'unversioned' } })
    expect(onEdit).not.toHaveBeenCalled()
  })
})

describe('custom editor document channel', () => {
  it('sends the buffer once the editor is ready, and nothing before', () => {
    const { host, posted, send } = setup({ text: '{"type":"excalidraw"}' })
    host.syncDocument()
    expect(posted).toEqual([])
    send({ type: 'orca-editor-ready' })
    expect(posted).toEqual([
      {
        type: 'orca-editor-document',
        version: 1,
        readOnly: false,
        content: { kind: 'text', text: '{"type":"excalidraw"}' }
      }
    ])
  })

  it('round-trips an edit into the buffer without echoing it back', () => {
    const { host, posted, onEdit, send } = setup({ text: 'a' })
    send({ type: 'orca-editor-ready' })
    send(edit('b'))
    expect(onEdit).toHaveBeenCalledWith('b')
    host.syncDocument()
    expect(posted).toHaveLength(1)
  })

  it('does not dirty the buffer for an edit equal to what it already holds', () => {
    const { onEdit, send } = setup({ text: 'same' })
    send({ type: 'orca-editor-ready' })
    send(edit('same'))
    expect(onEdit).not.toHaveBeenCalled()
  })

  it('pushes outside changes such as a reload from disk', () => {
    const { host, posted, doc, send } = setup({ text: 'old' })
    send({ type: 'orca-editor-ready' })
    doc.text = 'reloaded'
    host.syncDocument()
    expect(posted.at(-1)).toEqual({
      type: 'orca-editor-document',
      version: 2,
      readOnly: false,
      content: { kind: 'text', text: 'reloaded' }
    })
  })

  it('ignores edits for read-only documents and before ready', () => {
    const { onEdit, send } = setup({ text: 'a', readOnly: true })
    send(edit('early'))
    send({ type: 'orca-editor-ready' })
    send(edit('b'))
    expect(onEdit).not.toHaveBeenCalled()
  })

  it('refuses every edit from an editor its manifest marks read-only, on a writable tab', () => {
    const { posted, onEdit, onUnappliedEdit, send } = setup({ text: 'a', editorReadOnly: true })
    send({ type: 'orca-editor-ready' })
    expect(posted[0]).toMatchObject({ type: 'orca-editor-document', readOnly: true })
    send(edit('b'))
    send(edit('x'.repeat(CUSTOM_EDITOR_DOCUMENT_MAX_BYTES + 1)))
    expect(onEdit).not.toHaveBeenCalled()
    expect(onUnappliedEdit).not.toHaveBeenCalled()
  })

  it('refuses an edit over the size cap, tells the frame, and blocks the save', async () => {
    const { host, posted, onEdit, onEditRefused, onUnappliedEdit, send } = setup({ text: 'a' })
    send({ type: 'orca-editor-ready' })
    send(edit('x'.repeat(CUSTOM_EDITOR_DOCUMENT_MAX_BYTES + 1)))
    expect(onEdit).not.toHaveBeenCalled()
    expect(onEditRefused).toHaveBeenCalledWith('oversized')
    expect(onUnappliedEdit).toHaveBeenLastCalledWith('lost')
    expect(posted.at(-1)).toMatchObject({
      type: 'orca-editor-edit-rejected',
      baseVersion: 1,
      error: { code: 'too_large', retryable: false }
    })
    const flushed = host.flush()
    send({ type: 'orca-editor-flushed', requestId: 0 })
    // The buffer lacks the frame's latest change: a save must not mark the tab clean.
    await expect(flushed).resolves.toBe(false)
    send(edit('fits'))
    expect(onUnappliedEdit).toHaveBeenLastCalledWith(null)
    const caughtUp = host.flush()
    send({ type: 'orca-editor-flushed', requestId: 1 })
    await expect(caughtUp).resolves.toBe(true)
  })

  it('holds the newest rate-limited edit and applies it before a save', async () => {
    const { host, onEdit, onUnappliedEdit, send, answerFlushes } = setup({
      text: 'a',
      maxEdits: 1
    })
    send({ type: 'orca-editor-ready' })
    send(edit('b'))
    send(edit('c'))
    send(edit('d'))
    expect(onEdit).toHaveBeenCalledTimes(1)
    expect(onUnappliedEdit).toHaveBeenLastCalledWith('held')
    const flushed = host.flush()
    answerFlushes()
    await expect(flushed).resolves.toBe(true)
    expect(onEdit).toHaveBeenLastCalledWith('d')
    expect(onUnappliedEdit).toHaveBeenLastCalledWith(null)
  })

  it('never spends the edit budget on chords or flush replies', () => {
    const { onEdit, send } = setup({ text: 'a', maxEdits: 1 })
    send({ type: 'orca-editor-ready' })
    for (let index = 0; index < 5; index += 1) {
      send({ type: 'orca-editor-keydown', key: 's', code: 'KeyS', metaKey: true })
      send({ type: 'orca-editor-flushed', requestId: index })
    }
    send(edit('b'))
    expect(onEdit).toHaveBeenCalledWith('b')
  })

  it('waits for the frame to flush before a save, and times out if it never answers', async () => {
    const { host, posted, send } = setup({ text: 'a' })
    send({ type: 'orca-editor-ready' })
    const flushed = host.flush()
    expect(posted.at(-1)).toEqual({ type: 'orca-editor-flush', requestId: 0 })
    send(edit('pending'))
    send({ type: 'orca-editor-flushed', requestId: 0 })
    await expect(flushed).resolves.toBe(true)
    // A frame that never answers holds edits Orca can't see.
    await expect(host.flush()).resolves.toBe(false)
  })

  it('a remounted frame must announce ready before it receives the document again', () => {
    const { host, posted, send } = setup({ text: 'a' })
    send({ type: 'orca-editor-ready' })
    host.reset()
    host.syncDocument()
    expect(posted).toHaveLength(1)
    send({ type: 'orca-editor-ready' })
    expect(posted).toHaveLength(2)
  })
})

describe('readCustomEditorFrameMessage', () => {
  it('drops anything outside the protocol', () => {
    expect(readCustomEditorFrameMessage(null)).toBeNull()
    expect(readCustomEditorFrameMessage({ type: 'orca-editor-edit', text: 1 })).toBeNull()
    expect(readCustomEditorFrameMessage({ type: 'orca-panel-action' })).toBeNull()
    // Chords come from main's view of real input, never from the editor.
    expect(
      readCustomEditorFrameMessage({ type: 'orca-editor-keydown', key: 's', metaKey: true })
    ).toBeNull()
    expect(
      readCustomEditorFrameMessage({ type: 'orca-editor-edit', content: { kind: 'bytes' } })
    ).toBeNull()
  })

  it('reads only the versioned content edit', () => {
    expect(readCustomEditorFrameMessage(edit('x', 3))).toEqual({
      type: 'orca-editor-edit',
      text: 'x',
      baseVersion: 3
    })
    expect(readCustomEditorFrameMessage({ type: 'orca-editor-edit', text: 'y' })).toBeNull()
  })
})
