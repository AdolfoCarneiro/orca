import { describe, expect, it, vi } from 'vitest'
import {
  CUSTOM_EDITOR_DOCUMENT_MAX_BYTES,
  readCustomEditorFrameMessage
} from '../../../../shared/plugins/plugin-custom-editor-bridge'
import { createCustomEditorHost } from './plugin-custom-editor-host'

const edit = (text: string, baseVersion = 1) => ({
  type: 'orca-editor-edit',
  baseVersion,
  content: { kind: 'text', text }
})

function setup(initial: { text: string; readOnly?: boolean }) {
  const posted: unknown[] = []
  const frameWindow = { postMessage: (message: unknown) => posted.push(message) }
  const doc = { text: initial.text, readOnly: initial.readOnly ?? false }
  const onEdit = vi.fn((text: string) => {
    doc.text = text
  })
  const onEditRefused = vi.fn()
  const onKeyChord = vi.fn()
  const host = createCustomEditorHost({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the host only calls postMessage and compares identity.
    getFrameWindow: () => frameWindow as unknown as Window,
    getDocument: () => doc,
    onEdit,
    onEditRefused,
    onKeyChord,
    flushTimeoutMs: 50
  })
  const send = (data: unknown, source: unknown = frameWindow) =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: handleMessage reads only data and source.
    host.handleMessage({ data, source } as MessageEvent)
  return { host, posted, doc, onEdit, onEditRefused, onKeyChord, send }
}

function setupBytes() {
  const posted: { message: unknown; transfer: unknown }[] = []
  const frameWindow = {
    postMessage: (message: unknown, _origin: string, transfer: unknown) =>
      posted.push({ message, transfer })
  }
  let binary: { bytes: Uint8Array<ArrayBuffer>; fileType: string } | null = null
  const onEdit = vi.fn()
  const host = createCustomEditorHost({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the host only calls postMessage and compares identity.
    getFrameWindow: () => frameWindow as unknown as Window,
    getDocument: () => ({ text: '', readOnly: true }),
    getBinaryDocument: () => binary,
    onEdit
  })
  const send = (data: unknown) =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: handleMessage reads only data and source.
    host.handleMessage({ data, source: frameWindow } as unknown as MessageEvent)
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

  it('ignores messages from any window but the editor frame', () => {
    const { onEdit, posted, send } = setup({ text: 'a' })
    send({ type: 'orca-editor-ready' }, {})
    send(edit('b'), null)
    expect(posted).toEqual([])
    expect(onEdit).not.toHaveBeenCalled()
  })

  it('refuses an edit over the size cap and reports it', () => {
    const { onEdit, onEditRefused, send } = setup({ text: 'a' })
    send({ type: 'orca-editor-ready' })
    send(edit('x'.repeat(CUSTOM_EDITOR_DOCUMENT_MAX_BYTES + 1)))
    expect(onEdit).not.toHaveBeenCalled()
    expect(onEditRefused).toHaveBeenCalledWith('oversized')
  })

  it('waits for the frame to flush before a save, and times out if it never answers', async () => {
    const { host, posted, send } = setup({ text: 'a' })
    send({ type: 'orca-editor-ready' })
    const flushed = host.flush()
    expect(posted.at(-1)).toEqual({ type: 'orca-editor-flush', requestId: 0 })
    send(edit('pending'))
    send({ type: 'orca-editor-flushed', requestId: 0 })
    await expect(flushed).resolves.toBeUndefined()
    await expect(host.flush()).resolves.toBeUndefined()
  })

  it('forwards key chords from the shell for Orca to match', () => {
    const { onKeyChord, send } = setup({ text: 'a' })
    send({ type: 'orca-editor-keydown', key: 's', code: 'KeyS', metaKey: true })
    expect(onKeyChord).toHaveBeenCalledWith(
      expect.objectContaining({ key: 's', metaKey: true, ctrlKey: false })
    )
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
    expect(
      readCustomEditorFrameMessage({ type: 'orca-editor-keydown', key: 'x'.repeat(65), code: 'a' })
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
