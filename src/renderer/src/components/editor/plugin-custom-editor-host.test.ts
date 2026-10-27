import { describe, expect, it, vi } from 'vitest'
import {
  CUSTOM_EDITOR_DOCUMENT_MAX_BYTES,
  readCustomEditorFrameMessage
} from '../../../../shared/plugins/plugin-custom-editor-bridge'
import { createCustomEditorHost } from './plugin-custom-editor-host'

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

describe('custom editor document channel', () => {
  it('sends the buffer once the editor is ready, and nothing before', () => {
    const { host, posted, send } = setup({ text: '{"type":"excalidraw"}' })
    host.syncDocument()
    expect(posted).toEqual([])
    send({ type: 'orca-editor-ready' })
    expect(posted).toEqual([
      { type: 'orca-editor-document', text: '{"type":"excalidraw"}', readOnly: false }
    ])
  })

  it('round-trips an edit into the buffer without echoing it back', () => {
    const { host, posted, onEdit, send } = setup({ text: 'a' })
    send({ type: 'orca-editor-ready' })
    send({ type: 'orca-editor-edit', text: 'b' })
    expect(onEdit).toHaveBeenCalledWith('b')
    host.syncDocument()
    expect(posted).toHaveLength(1)
  })

  it('does not dirty the buffer for an edit equal to what it already holds', () => {
    const { onEdit, send } = setup({ text: 'same' })
    send({ type: 'orca-editor-ready' })
    send({ type: 'orca-editor-edit', text: 'same' })
    expect(onEdit).not.toHaveBeenCalled()
  })

  it('pushes outside changes such as a reload from disk', () => {
    const { host, posted, doc, send } = setup({ text: 'old' })
    send({ type: 'orca-editor-ready' })
    doc.text = 'reloaded'
    host.syncDocument()
    expect(posted.at(-1)).toEqual({
      type: 'orca-editor-document',
      text: 'reloaded',
      readOnly: false
    })
  })

  it('ignores edits for read-only documents and before ready', () => {
    const { onEdit, send } = setup({ text: 'a', readOnly: true })
    send({ type: 'orca-editor-edit', text: 'early' })
    send({ type: 'orca-editor-ready' })
    send({ type: 'orca-editor-edit', text: 'b' })
    expect(onEdit).not.toHaveBeenCalled()
  })

  it('ignores messages from any window but the editor frame', () => {
    const { onEdit, posted, send } = setup({ text: 'a' })
    send({ type: 'orca-editor-ready' }, {})
    send({ type: 'orca-editor-edit', text: 'b' }, null)
    expect(posted).toEqual([])
    expect(onEdit).not.toHaveBeenCalled()
  })

  it('refuses an edit over the size cap and reports it', () => {
    const { onEdit, onEditRefused, send } = setup({ text: 'a' })
    send({ type: 'orca-editor-ready' })
    send({ type: 'orca-editor-edit', text: 'x'.repeat(CUSTOM_EDITOR_DOCUMENT_MAX_BYTES + 1) })
    expect(onEdit).not.toHaveBeenCalled()
    expect(onEditRefused).toHaveBeenCalledWith('oversized')
  })

  it('waits for the frame to flush before a save, and times out if it never answers', async () => {
    const { host, posted, send } = setup({ text: 'a' })
    send({ type: 'orca-editor-ready' })
    const flushed = host.flush()
    expect(posted.at(-1)).toEqual({ type: 'orca-editor-flush', requestId: 0 })
    send({ type: 'orca-editor-edit', text: 'pending' })
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
  })
})
