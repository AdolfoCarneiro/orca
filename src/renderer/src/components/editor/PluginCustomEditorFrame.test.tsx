// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActivePluginCustomEditor } from '@/store/plugin-custom-editors'
import type { PluginEditorGuestEvent } from '../../../../shared/plugins/plugin-editor-guest'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    fallback.replace('{{value0}}', values?.value0 ?? '')
}))

vi.mock('./editor-shortcuts', () => ({
  editorShortcutMatches: (actionId: string, event: KeyboardEvent) =>
    actionId === 'editor.save' && (event.metaKey || event.ctrlKey) && event.key === 's'
}))

vi.mock('@/components/browser-pane/host-guest/webview-registry', () => ({
  moveFocusToRendererBeforeWebviewDetach: () => {}
}))

import PluginCustomEditorFrame from './PluginCustomEditorFrame'
import { flushEditorFrames } from './editor-pending-flush'

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const FILE_ID = '/repo/diagram.excalidraw'
const TOKEN = 'a'.repeat(32)
const SAVE_CHORD = {
  key: 's',
  code: 'KeyS',
  metaKey: true,
  ctrlKey: false,
  altKey: false,
  shiftKey: false
}

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
let guestListener: ((event: PluginEditorGuestEvent) => void) | null = null
let delivered: unknown[] = []
const openCustomEditorGuest = vi.fn()
const closeCustomEditorGuest = vi.fn()

function ticket(fields: Partial<{ readonly: boolean; revision: string }> = {}) {
  return {
    token: TOKEN,
    src: `orca-plugin-editor://${TOKEN}/`,
    readonly: false,
    revision: 'r1',
    ...fields
  }
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  delivered = []
  guestListener = null
  openCustomEditorGuest.mockReset()
  openCustomEditorGuest.mockResolvedValue(ticket())
  closeCustomEditorGuest.mockReset()
  // happy-dom has no <webview>; give every element the one guest method the frame calls.
  Object.defineProperty(HTMLElement.prototype, 'send', {
    configurable: true,
    value: (_channel: string, message: unknown) => delivered.push(message)
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the frame reads only these plugin bridge methods.
  globalThis.window.api = {
    plugins: {
      openCustomEditorGuest,
      closeCustomEditorGuest,
      onCustomEditorGuestEvent: (listener: (event: PluginEditorGuestEvent) => void) => {
        guestListener = listener
        return () => {
          guestListener = null
        }
      },
      onChanged: () => vi.fn()
    }
  } as unknown as Window['api']
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  Reflect.deleteProperty(HTMLElement.prototype, 'send')
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
        fileId={props.binaryDocument ? undefined : FILE_ID}
        content={props.content}
        readOnly={props.readOnly ?? false}
        onContentChange={onContentChange}
        onSave={onSave}
        binaryDocument={props.binaryDocument}
      />
    )
  })
  const webview = container.querySelector('webview')
  await act(async () => {
    webview?.dispatchEvent(new Event('dom-ready'))
  })
  const fromGuest = async (event: PluginEditorGuestEvent) => {
    await act(async () => {
      guestListener?.(event)
    })
  }
  const fromFrame = (data: unknown) => fromGuest({ token: TOKEN, kind: 'message', data })
  return { webview, fromGuest, fromFrame, onContentChange, onSave }
}

const documentMessages = () =>
  delivered.filter(
    (message) =>
      typeof message === 'object' &&
      message !== null &&
      'type' in message &&
      message.type === 'orca-editor-document'
  )

describe('PluginCustomEditorFrame', () => {
  it('runs the editor as a guest of the network-isolated editor partition', async () => {
    const { webview } = await renderFrame({ content: '{}' })
    expect(openCustomEditorGuest).toHaveBeenCalledWith({
      pluginKey: 'stablyai.excalidraw',
      editorId: 'excalidraw',
      colorScheme: 'light',
      tokens: expect.any(String)
    })
    expect(container.querySelector('iframe')).toBeNull()
    expect(webview?.getAttribute('partition')).toBe('orca-plugin-editor')
    expect(webview?.getAttribute('src')).toBe(`orca-plugin-editor://${TOKEN}/`)
  })

  it('sends the buffer on ready and applies edits without saving', async () => {
    const { fromFrame, onContentChange, onSave } = await renderFrame({ content: 'scene' })
    await fromFrame({ type: 'orca-editor-ready' })
    expect(documentMessages()).toEqual([
      {
        type: 'orca-editor-document',
        version: 1,
        readOnly: false,
        content: { kind: 'text', text: 'scene' }
      }
    ])
    await fromFrame({
      type: 'orca-editor-edit',
      baseVersion: 1,
      content: { kind: 'text', text: 'scene+rect' }
    })
    expect(onContentChange).toHaveBeenCalledWith('scene+rect')
    expect(onSave).not.toHaveBeenCalled()
  })

  it('saves only on a save chord main read from real input, never on one the editor posts', async () => {
    const { fromGuest, fromFrame, onSave } = await renderFrame({ content: 'scene' })
    await fromFrame({ type: 'orca-editor-ready' })
    await fromFrame({ type: 'orca-editor-keydown', ...SAVE_CHORD })
    await fromGuest({ token: 'b'.repeat(32), kind: 'keydown', chord: SAVE_CHORD })
    expect(onSave).not.toHaveBeenCalled()
    await fromGuest({ token: TOKEN, kind: 'keydown', chord: SAVE_CHORD })
    expect(onSave).toHaveBeenCalledWith('scene')
  })

  it('flushes the frame before any save of the file, and keeps the tab unsaved if it never answers', async () => {
    const { fromFrame } = await renderFrame({ content: 'scene' })
    await fromFrame({ type: 'orca-editor-ready' })
    const index = { editorBufferIdOf: {}, editorBufferViews: {} }
    const flushed = flushEditorFrames(index, FILE_ID)
    expect(delivered.at(-1)).toEqual({ type: 'orca-editor-flush', requestId: 0 })
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
    const { fromGuest, fromFrame, onContentChange, onSave } = await renderFrame({
      content: 'scene',
      readOnly: true
    })
    await fromFrame({ type: 'orca-editor-ready' })
    expect(documentMessages()[0]).toMatchObject({ readOnly: true })
    await fromFrame({
      type: 'orca-editor-edit',
      baseVersion: 1,
      content: { kind: 'text', text: 'tampered' }
    })
    await fromGuest({ token: TOKEN, kind: 'keydown', chord: SAVE_CHORD })
    expect(onContentChange).not.toHaveBeenCalled()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('restyles in place on a theme change instead of remounting and losing editor state', async () => {
    const { webview } = await renderFrame({ content: 'scene' })
    await act(async () => {
      document.documentElement.classList.add('dark')
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(container.querySelector('webview')).toBe(webview)
    expect(delivered).toContainEqual({
      type: 'orca-panel-theme',
      colorScheme: 'dark',
      tokens: expect.any(String)
    })
    document.documentElement.classList.remove('dark')
  })

  it('sends a bytes document and ignores edits', async () => {
    const { fromFrame, onContentChange } = await renderFrame({
      content: '',
      readOnly: true,
      binaryDocument: { bytes: new Uint8Array([1, 2, 3]), fileType: 'xlsx' }
    })
    await fromFrame({ type: 'orca-editor-ready' })
    expect(documentMessages()[0]).toMatchObject({
      type: 'orca-editor-document',
      version: 1,
      readOnly: true,
      fileType: 'xlsx',
      content: { kind: 'bytes' }
    })
    await fromFrame({
      type: 'orca-editor-edit',
      baseVersion: 1,
      content: { kind: 'text', text: 'x' }
    })
    expect(onContentChange).not.toHaveBeenCalled()
  })

  it('closes its guest on unmount', async () => {
    await renderFrame({ content: 'scene' })
    await act(async () => root.unmount())
    expect(closeCustomEditorGuest).toHaveBeenCalledWith(TOKEN)
    root = createRoot(container)
  })

  it('says so when the plugin can no longer serve its editor', async () => {
    openCustomEditorGuest.mockResolvedValue(null)
    await renderFrame({ content: '' })
    expect(container.querySelector('webview')).toBeNull()
    expect(container.textContent).toContain('Excalidraw could not be loaded')
  })
})
