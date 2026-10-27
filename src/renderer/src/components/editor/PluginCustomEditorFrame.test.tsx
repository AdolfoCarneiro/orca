// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActivePluginCustomEditor } from '@/store/plugin-custom-editors'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    fallback.replace('{{value0}}', values?.value0 ?? '')
}))

vi.mock('./editor-shortcuts', () => ({
  editorShortcutMatches: (actionId: string, event: KeyboardEvent) =>
    actionId === 'editor.save' && (event.metaKey || event.ctrlKey) && event.key === 's'
}))

import PluginCustomEditorFrame from './PluginCustomEditorFrame'
import { flushEditorFrames } from './editor-pending-flush'

const FILE_ID = '/repo/diagram.excalidraw'

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const editor: ActivePluginCustomEditor = {
  id: 'excalidraw',
  title: 'Excalidraw',
  fileTypes: ['excalidraw'],
  priority: 'default',
  key: 'stablyai.excalidraw/excalidraw',
  pluginKey: 'stablyai.excalidraw',
  pluginName: 'Excalidraw'
}

let container: HTMLDivElement
let root: Root
const readCustomEditorEntry = vi.fn()

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  readCustomEditorEntry.mockReset()
  readCustomEditorEntry.mockResolvedValue({ html: '<main>editor</main>' })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the frame reads only these two plugin bridge methods.
  globalThis.window.api = {
    plugins: { readCustomEditorEntry, onChanged: () => vi.fn() }
  } as unknown as Window['api']
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

async function renderFrame(props: {
  content: string
  readOnly?: boolean
  onContentChange?: (content: string) => void
  onSave?: (content: string) => Promise<boolean>
  binaryDocument?: { bytes: Uint8Array<ArrayBuffer>; fileType: string }
}) {
  const onContentChange = props.onContentChange ?? vi.fn()
  const onSave = props.onSave ?? vi.fn().mockResolvedValue(true)
  await act(async () => {
    root.render(
      <PluginCustomEditorFrame
        editor={editor}
        fileId={FILE_ID}
        content={props.content}
        readOnly={props.readOnly ?? false}
        onContentChange={onContentChange}
        onSave={onSave}
        binaryDocument={props.binaryDocument}
      />
    )
  })
  const iframe = container.querySelector('iframe')!
  const frameWindow = iframe.contentWindow!
  const posted = vi.spyOn(frameWindow, 'postMessage')
  const fromFrame = async (data: unknown) => {
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', { data, source: frameWindow }))
    })
  }
  return { iframe, posted, fromFrame, onContentChange, onSave }
}

describe('PluginCustomEditorFrame', () => {
  it('renders the editor in a scripts-only sandbox with the no-network shell', async () => {
    const { iframe } = await renderFrame({ content: '{}' })
    expect(readCustomEditorEntry).toHaveBeenCalledWith({
      pluginKey: 'stablyai.excalidraw',
      editorId: 'excalidraw'
    })
    // allow-same-origin would expose app DOM, storage and IPC to the plugin.
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts')
    expect(iframe.getAttribute('name')?.startsWith('orca-plugin-panel:editor:')).toBe(true)
    // window.name is readable in the frame, so it must not name the file.
    expect(iframe.getAttribute('name')).not.toContain('diagram')
    expect(iframe.getAttribute('name')).not.toContain('/repo')
    expect(iframe.getAttribute('srcdoc')).toContain('<main>editor</main>')
  })

  it('sends the buffer on ready and applies edits without saving', async () => {
    const { posted, fromFrame, onContentChange, onSave } = await renderFrame({ content: 'scene' })
    await fromFrame({ type: 'orca-editor-ready' })
    expect(posted).toHaveBeenCalledWith(
      {
        type: 'orca-editor-document',
        version: 1,
        readOnly: false,
        content: { kind: 'text', text: 'scene' }
      },
      '*',
      []
    )
    await fromFrame({
      type: 'orca-editor-edit',
      baseVersion: 1,
      content: { kind: 'text', text: 'scene+rect' }
    })
    expect(onContentChange).toHaveBeenCalledWith('scene+rect')
    expect(onSave).not.toHaveBeenCalled()
  })

  it('flushes the frame before any save of the file, and keeps the tab unsaved if it never answers', async () => {
    const { posted, fromFrame } = await renderFrame({ content: 'scene' })
    await fromFrame({ type: 'orca-editor-ready' })
    const index = { editorBufferIdOf: {}, editorBufferViews: {} }
    const flushed = flushEditorFrames(index, FILE_ID)
    expect(posted).toHaveBeenLastCalledWith({ type: 'orca-editor-flush', requestId: 0 }, '*', [])
    await fromFrame({
      type: 'orca-editor-edit',
      baseVersion: 1,
      content: { kind: 'text', text: 'scene+late' }
    })
    await fromFrame({ type: 'orca-editor-flushed', requestId: 0 })
    await expect(flushed).resolves.toBe(true)

    let silent: Promise<boolean> | null = null
    await act(async () => {
      silent = flushEditorFrames(index, FILE_ID)
      await silent
    })
    await expect(silent).resolves.toBe(false)
    expect(container.textContent).toContain("Couldn't save the latest changes from Excalidraw")
  })

  it('never saves or edits a read-only document', async () => {
    const { fromFrame, onContentChange, onSave, posted } = await renderFrame({
      content: 'scene',
      readOnly: true
    })
    await fromFrame({ type: 'orca-editor-ready' })
    expect(posted).toHaveBeenCalledWith(
      {
        type: 'orca-editor-document',
        version: 1,
        readOnly: true,
        content: { kind: 'text', text: 'scene' }
      },
      '*',
      []
    )
    await fromFrame({
      type: 'orca-editor-edit',
      baseVersion: 1,
      content: { kind: 'text', text: 'tampered' }
    })
    await fromFrame({ type: 'orca-editor-keydown', key: 's', code: 'KeyS', metaKey: true })
    expect(onContentChange).not.toHaveBeenCalled()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('restyles in place on a theme change instead of remounting and losing editor state', async () => {
    const { iframe, posted } = await renderFrame({ content: 'scene' })
    await act(async () => {
      document.documentElement.classList.add('dark')
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(container.querySelector('iframe')).toBe(iframe)
    expect(posted).toHaveBeenCalledWith(
      { type: 'orca-panel-theme', colorScheme: 'dark', tokens: expect.any(String) },
      '*'
    )
    document.documentElement.classList.remove('dark')
  })

  it('sends a bytes document as a transferred ArrayBuffer and ignores edits', async () => {
    const { posted, fromFrame, onContentChange } = await renderFrame({
      content: '',
      readOnly: true,
      binaryDocument: { bytes: new Uint8Array([1, 2, 3]), fileType: 'xlsx' }
    })
    await fromFrame({ type: 'orca-editor-ready' })
    const [message, origin, transfer]: unknown[] = posted.mock.calls[0] ?? []
    expect(message).toMatchObject({
      type: 'orca-editor-document',
      version: 1,
      readOnly: true,
      fileType: 'xlsx',
      content: { kind: 'bytes' }
    })
    expect(origin).toBe('*')
    expect(transfer).toHaveLength(1)
    await fromFrame({
      type: 'orca-editor-edit',
      baseVersion: 1,
      content: { kind: 'text', text: 'x' }
    })
    expect(onContentChange).not.toHaveBeenCalled()
  })

  it('says so when the plugin can no longer serve its editor', async () => {
    readCustomEditorEntry.mockResolvedValue(null)
    await act(async () => {
      root.render(
        <PluginCustomEditorFrame
          editor={editor}
          fileId={FILE_ID}
          content=""
          readOnly={false}
          onContentChange={vi.fn()}
          onSave={vi.fn()}
        />
      )
    })
    expect(container.querySelector('iframe')).toBeNull()
    expect(container.textContent).toContain('Excalidraw could not be loaded')
  })
})
