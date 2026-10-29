// @vitest-environment happy-dom
import type * as ImageBlobPng from '@/lib/image-blob-png'
import { Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import { Fragment, Slice } from '@tiptap/pm/model'
import { afterEach, expect, it, vi } from 'vitest'
import { handleRichMarkdownImagePaste } from './rich-markdown-paste-image'

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({ settings: null, folderWorkspaces: [], worktreesByRepo: {}, openFiles: [] })
  }
}))
vi.mock('@/lib/connection-context', () => ({ getConnectionId: () => null }))
vi.mock('@/lib/image-blob-png', async (original) => ({
  ...(await original<typeof ImageBlobPng>()),
  convertImageBlobToPng: async (blob: Blob) => blob
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn() } }))

async function closePendingEditor(waitForImport?: Promise<void>) {
  const element = document.createElement('div')
  document.body.append(element)
  const editor = new Editor({
    element,
    extensions: [StarterKit, Image.configure({ inline: true })],
    content: {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'x'.repeat(2 * 1024 * 1024) }] }
      ]
    }
  })
  const refs = {
    editor: new WeakRef(editor),
    document: new WeakRef(editor.state.doc),
    dom: new WeakRef(editor.view.dom)
  }
  const clipboardData = new DataTransfer()
  clipboardData.setData('text/html', '<img src="blob:first">')
  expect(
    handleRichMarkdownImagePaste({
      editor,
      event: new ClipboardEvent('paste', { clipboardData, cancelable: true }),
      filePath: '/notes/note.md',
      worktreeId: null,
      slice: new Slice(Fragment.from(editor.schema.nodes.image.create({ src: 'blob:first' })), 0, 0)
    })
  ).toBe(true)
  if (waitForImport) {
    await waitForImport
  }
  editor.destroy()
  element.remove()
  return refs
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

it.each(['read', 'import'])(
  'releases closed editors before a noncooperative %s settles',
  async (stage) => {
    const reading = Promise.withResolvers<Response>()
    const importing = Promise.withResolvers<{ ok: true; result: string }>()
    let started = Promise.withResolvers<void>()
    const save = vi.fn(() => {
      started.resolve()
      return importing.promise
    })
    const copy = vi.fn()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { runtime: { call: save }, fs: { importExternalPaths: copy } }
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        stage === 'read'
          ? reading.promise
          : Promise.resolve({
              ok: true,
              blob: async () => new Blob(['image'], { type: 'image/png' })
            })
      )
    )
    const refs: Awaited<ReturnType<typeof closePendingEditor>>[] = []
    try {
      for (let count = 0; count < 8; count++) {
        started = Promise.withResolvers<void>()
        refs.push(await closePendingEditor(stage === 'import' ? started.promise : undefined))
      }
      // Destroyed editors still have queued Tiptap creation callbacks.
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
      if (!globalThis.gc) {
        throw new Error('The test runner must enable --expose-gc')
      }
      for (let turn = 0; turn < 3; turn++) {
        await new Promise<void>((resolve) => setImmediate(resolve))
        globalThis.gc()
      }
      expect({
        editors: refs.filter((ref) => ref.editor.deref()).length,
        documents: refs.filter((ref) => ref.document.deref()).length,
        doms: refs.filter((ref) => ref.dom.deref()).length
      }).toEqual({ editors: 0, documents: 0, doms: 0 })
      expect(copy).not.toHaveBeenCalled()
      expect(save).toHaveBeenCalledTimes(stage === 'import' ? 8 : 0)
    } finally {
      reading.resolve(new Response('late image'))
      importing.resolve({ ok: true, result: '/tmp/late.png' })
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }
)
