// @vitest-environment happy-dom
import type * as ImageBlobPng from '@/lib/image-blob-png'
import { Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import { Markdown } from '@tiptap/markdown'
import { TableKit } from '@tiptap/extension-table'
import { CellSelection } from '@tiptap/pm/tables'
import { AllSelection, NodeSelection } from '@tiptap/pm/state'
import { DOMParser } from '@tiptap/pm/model'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { handleRichMarkdownPaste } from './rich-markdown-paste-handler'
import { setRichMarkdownImageResolverContext } from './rich-markdown-image-context'

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({ settings: null, folderWorkspaces: [], worktreesByRepo: {}, openFiles: [] })
  }
}))
vi.mock('@/lib/connection-context', () => ({ getConnectionId: () => null }))
vi.mock('@/lib/image-blob-png', async (original) => {
  const actual = await original<typeof ImageBlobPng>()
  return { ...actual, convertImageBlobToPng: async (blob: Blob) => blob }
})
vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn() } }))

const editors: Editor[] = []
const saves = vi.fn()
const imports = vi.fn()

function createEditor(content = 'left right'): Editor {
  const element = document.createElement('div')
  document.body.append(element)
  const editor = new Editor({
    element,
    extensions: [StarterKit, Image.configure({ inline: true }), TableKit, Markdown],
    content,
    contentType: 'markdown'
  })
  editors.push(editor)
  editor.commands.setTextSelection(6)
  return editor
}

function paste(editor: Editor, html: string): void {
  const container = document.createElement('div')
  container.innerHTML = html
  const slice = DOMParser.fromSchema(editor.schema).parseSlice(container)
  const clipboardData = new DataTransfer()
  clipboardData.setData('text/html', html)
  clipboardData.setData('text/plain', 'caption bold between tail')
  const event = new ClipboardEvent('paste', { clipboardData, cancelable: true })
  if (
    !handleRichMarkdownPaste({
      editor,
      event,
      filePath: '/notes/note.md',
      worktreeId: '',
      slice,
      view: editor.view
    })
  ) {
    editor.view.dispatch(editor.state.tr.replaceSelection(slice).setMeta('uiEvent', 'paste'))
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  let next = 0
  saves.mockImplementation(async () => ({ ok: true, result: `/tmp/pasted-${++next}.png` }))
  imports.mockImplementation(async ({ sourcePaths }: { sourcePaths: string[] }) => ({
    results: sourcePaths.map((sourcePath) => ({
      status: 'imported',
      kind: 'file',
      sourcePath,
      destPath: `/notes/${sourcePath.split('/').at(-1)}`,
      renamed: false
    }))
  }))
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { runtime: { call: saves }, fs: { importExternalPaths: imports } }
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (src: string) => ({
      ok: true,
      blob: async () => new Blob([src], { type: 'image/png' })
    }))
  )
})

afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy())
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

it('saves selected HTML blob images beside the note and reopens the entire pasted slice', async () => {
  const editor = createEditor()
  const updated = Promise.withResolvers<void>()
  editor.on('update', () => updated.resolve())
  paste(
    editor,
    '<p>caption <strong>bold</strong><img src="blob:first" alt="first" title="one"> between <img src="blob:second" alt="second"></p><ul><li>tail</li></ul>'
  )
  await updated.promise
  const markdown = editor.getMarkdown()
  expect(markdown).not.toContain('blob:')
  expect(markdown).toContain('![first](pasted-1.png "one")')
  expect(markdown).toContain('![second](pasted-2.png)')
  expect(markdown).toContain('**bold**')
  expect(markdown).toContain('- tail')
  const reopened = createEditor(markdown)
  expect(reopened.getJSON()).toEqual(editor.getJSON())
  expect(saves.mock.calls.map(([args]) => args.params.contentBase64)).toEqual([
    btoa('blob:first'),
    btoa('blob:second')
  ])
  expect(editor.commands.undo()).toBe(true)
  expect(editor.getMarkdown()).toBe('left right')
})

it('starts every accepted source read before returning and aborts them when the editor closes', async () => {
  const pending = Promise.withResolvers<Response>()
  vi.mocked(fetch).mockReturnValue(pending.promise)
  const editor = createEditor()
  paste(editor, '<p><img src="blob:first"><img src="blob:second"></p>')
  expect(fetch).toHaveBeenCalledTimes(2)
  const signals = vi.mocked(fetch).mock.calls.map(([, options]) => options?.signal)
  expect(signals.every((signal) => signal && !signal.aborted)).toBe(true)
  editor.destroy()
  expect(signals.every((signal) => signal?.aborted)).toBe(true)
  pending.resolve(new Response('late bytes'))
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(saves).not.toHaveBeenCalled()
  expect(imports).not.toHaveBeenCalled()
})

it('imports repeated source URLs once while preserving both image attributes', async () => {
  const editor = createEditor()
  const updated = Promise.withResolvers<void>()
  editor.on('update', () => updated.resolve())
  paste(editor, '<p><img src="blob:same" alt="first"> and <img src="blob:same" alt="second"></p>')
  await updated.promise
  expect(editor.getMarkdown()).toContain('![first](pasted-1.png) and ![second](pasted-1.png)')
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(saves).toHaveBeenCalledTimes(1)
})

it('keeps the pending paste before subsequent typing without moving the live caret', async () => {
  const bytes = Promise.withResolvers<Response>()
  vi.mocked(fetch).mockReturnValue(bytes.promise)
  const editor = createEditor()
  paste(editor, '<p>caption <img src="blob:first" alt="first"></p>')
  editor.commands.insertContent('typed ')
  editor.commands.setTextSelection(editor.state.doc.content.size - 1)
  const updated = Promise.withResolvers<void>()
  editor.on('update', ({ transaction }) => {
    if (transaction.getMeta('uiEvent') === 'paste') {
      updated.resolve()
    }
  })
  bytes.resolve(new Response('first image', { headers: { 'Content-Type': 'image/png' } }))
  await updated.promise
  expect(editor.getMarkdown()).toBe('left caption ![first](pasted-1.png)typed right')
  expect(editor.state.selection.from).toBe(editor.state.doc.content.size - 1)
  expect(editor.commands.undo()).toBe(true)
  expect(editor.getMarkdown()).toBe('left typed right')
})

it('refuses a late image when the document owner changes', async () => {
  const bytes = Promise.withResolvers<Response>()
  vi.mocked(fetch).mockReturnValue(bytes.promise)
  const editor = createEditor()
  paste(editor, '<p><img src="blob:first"></p>')
  setRichMarkdownImageResolverContext(editor, { filePath: '/different/note.md' })
  bytes.resolve(new Response('first image'))
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(editor.getMarkdown()).toBe('left right')
  expect(saves).not.toHaveBeenCalled()
  expect(imports).not.toHaveBeenCalled()
})

it.each(['caret', 'single-cell', 'four-cells'])(
  'preserves ordinary table paste geometry at a %s target',
  async (kind) => {
    const source =
      '| A | B | C |\n| --- | --- | --- |\n| one | two | keep |\n| three | four | stay |'
    const editor = createEditor(source)
    const ordinary = createEditor(source)
    for (const owner of [editor, ordinary]) {
      const positions = new Map<string, number>()
      owner.state.doc.descendants((node, pos) => {
        if (node.type.name === 'tableCell') {
          positions.set(node.textContent, pos)
        }
      })
      const first = positions.get('one')
      const last = positions.get('four')
      if (first === undefined || last === undefined) {
        throw new Error('Missing test cells')
      }
      if (kind === 'caret') {
        owner.commands.setTextSelection(first + 2)
      } else {
        owner.view.dispatch(
          owner.state.tr.setSelection(
            CellSelection.create(owner.state.doc, first, kind === 'single-cell' ? first : last)
          )
        )
      }
    }
    const html =
      '<table><tbody><tr><td><p><img src="blob:first" alt="first"></p></td><td><p>pasted</p></td></tr></tbody></table>'
    expect(ordinary.view.pasteHTML(html.replace('blob:first', 'pasted-1.png'))).toBe(true)
    const updated = Promise.withResolvers<void>()
    editor.on('update', () => updated.resolve())
    paste(editor, html)
    await updated.promise
    expect(editor.getJSON()).toEqual(ordinary.getJSON())
    expect(editor.commands.undo()).toBe(true)
    expect(editor.getMarkdown()).toBe(createEditor(source).getMarkdown())
  }
)

it.each(['all', 'image-node'])(
  'preserves ordinary paste behavior for a %s selection',
  async (kind) => {
    const source = 'before ![old](old.png) after\n\nlast'
    const editor = createEditor(source)
    const ordinary = createEditor(source)
    for (const owner of [editor, ordinary]) {
      let imagePosition: number | undefined
      owner.state.doc.descendants((node, pos) => {
        if (node.type.name === 'image') {
          imagePosition = pos
        }
      })
      if (imagePosition === undefined) {
        throw new Error('Missing test image')
      }
      owner.view.dispatch(
        owner.state.tr.setSelection(
          kind === 'all'
            ? new AllSelection(owner.state.doc)
            : NodeSelection.create(owner.state.doc, imagePosition)
        )
      )
    }
    const html = '<p>caption <img src="blob:first" alt="first"></p>'
    ordinary.view.pasteHTML(html.replace('blob:first', 'pasted-1.png'))
    const updated = Promise.withResolvers<void>()
    editor.on('update', () => updated.resolve())
    paste(editor, html)
    await updated.promise
    expect(editor.getJSON()).toEqual(ordinary.getJSON())
  }
)

it('preserves request order when the later image paste completes first', async () => {
  const first = Promise.withResolvers<Response>()
  const second = Promise.withResolvers<Response>()
  vi.mocked(fetch).mockImplementation((src) =>
    String(src) === 'blob:first' ? first.promise : second.promise
  )
  const editor = createEditor()
  paste(editor, '<p><img src="blob:first" alt="first"></p>')
  paste(editor, '<p><img src="blob:second" alt="second"></p>')
  const laterDone = Promise.withResolvers<void>()
  editor.on('update', () => laterDone.resolve())
  second.resolve(new Response('second image'))
  await laterDone.promise
  expect([...editor.view.dom.querySelectorAll('img')].map((image) => image.alt)).toEqual(['second'])
  const earlierDone = Promise.withResolvers<void>()
  editor.on('update', () => earlierDone.resolve())
  first.resolve(new Response('first image'))
  await earlierDone.promise
  expect([...editor.view.dom.querySelectorAll('img')].map((image) => image.alt)).toEqual([
    'first',
    'second'
  ])
  expect(editor.getMarkdown()).not.toContain('blob:')
})
