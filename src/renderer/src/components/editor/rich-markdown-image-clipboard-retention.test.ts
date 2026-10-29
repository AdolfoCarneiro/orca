// @vitest-environment happy-dom
import { Editor, type JSONContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import { Markdown } from '@tiptap/markdown'
import { TableKit } from '@tiptap/extension-table'
import { DOMParser } from '@tiptap/pm/model'
import { afterEach, expect, it, vi } from 'vitest'
import { handleRichMarkdownPaste } from './rich-markdown-paste-handler'
import { handleRichMarkdownImageDrop } from './rich-markdown-image-drop'
import { setRichMarkdownImageResolverContext } from './rich-markdown-image-context'
import { RichMarkdownImageClipboard } from './rich-markdown-image-clipboard'

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({ settings: null, folderWorkspaces: [], worktreesByRepo: {}, openFiles: [] })
  }
}))
vi.mock('@/lib/connection-context', () => ({ getConnectionId: () => null }))
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() }
}))
const editors: Editor[] = []
const read = vi.fn<() => Promise<{ isBinary: boolean; content: string; mimeType: string }>>()
const save = vi.fn()

function createEditor(content: JSONContent, filePath = '/source/note.md'): Editor {
  const element = document.createElement('div')
  document.body.append(element)
  const editor = new Editor({
    element,
    extensions: [
      StarterKit,
      Image.configure({ inline: true }),
      RichMarkdownImageClipboard,
      TableKit,
      Markdown
    ],
    content
  })
  editors.push(editor)
  setRichMarkdownImageResolverContext(editor, { filePath })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { fs: { readFile: read }, runtime: { call: save } }
  })
  return editor
}

function paste(editor: Editor, html: string): void {
  const data = new DataTransfer()
  data.setData('text/html', html)
  const element = document.createElement('div')
  element.innerHTML = html
  expect(
    handleRichMarkdownPaste({
      editor,
      event: new ClipboardEvent('paste', { clipboardData: data, cancelable: true }),
      filePath: '/target/note.md',
      worktreeId: '',
      slice: DOMParser.fromSchema(editor.schema).parseSlice(element),
      view: editor.view
    })
  ).toBe(true)
}

function drop(editor: Editor, html: string, position: number): void {
  const data = new DataTransfer()
  data.setData('text/html', html)
  const event = new DragEvent('drop', { cancelable: true })
  Object.defineProperties(event, {
    dataTransfer: { value: data },
    clientX: { value: 50 },
    clientY: { value: 50 }
  })
  const element = document.createElement('div')
  element.innerHTML = html
  const coordinates = editor.view.posAtCoords
  editor.view.posAtCoords = () => ({ pos: position, inside: -1 })
  try {
    expect(
      handleRichMarkdownImageDrop({
        editor,
        view: editor.view,
        event,
        slice: DOMParser.fromSchema(editor.schema).parseSlice(element),
        moved: false,
        filePath: '/target/note.md',
        worktreeId: ''
      })
    ).toBe(true)
  } finally {
    editor.view.posAtCoords = coordinates
  }
}

afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy())
  document.getSelection()?.removeAllRanges()
  document.body.replaceChildren()
  vi.useRealTimers()
  vi.clearAllMocks()
})

async function closeCopiedEditorsWhileReading(started: Promise<void>, operation: 'paste' | 'drop') {
  const source = createEditor({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'x'.repeat(1024 * 1024) },
          { type: 'image', attrs: { src: 'image.png' } }
        ]
      }
    ]
  })
  let imagePosition = -1
  source.state.doc.descendants((node, pos) => {
    if (node.type.name === 'image') {
      imagePosition = pos
    }
  })
  if (imagePosition < 0) {
    throw new Error('Missing source image')
  }
  source.commands.setNodeSelection(imagePosition)
  const html = source.view.serializeForClipboard(source.state.selection.content()).dom.innerHTML
  const target = createEditor(
    {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'y'.repeat(1024 * 1024) }] }]
    },
    '/target/note.md'
  )
  const refs = [source, target].map((editor) => ({
    editor: new WeakRef(editor),
    document: new WeakRef(editor.state.doc),
    dom: new WeakRef(editor.view.dom)
  }))
  if (operation === 'paste') {
    paste(target, html)
  } else {
    drop(target, html, 1)
  }
  await started
  for (const owner of [source, target]) {
    const dom = owner.view.dom.parentElement
    owner.destroy()
    dom?.remove()
    editors.splice(editors.indexOf(owner), 1)
  }
  return refs
}

it.each(['paste', 'drop'] as const)(
  'releases both closed editors during a pending %s source read',
  async (operation) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const held = Promise.withResolvers<{ isBinary: boolean; content: string; mimeType: string }>()
    const started = Promise.withResolvers<void>()
    read.mockImplementationOnce(() => {
      started.resolve()
      return held.promise
    })
    const refs = await closeCopiedEditorsWhileReading(started.promise, operation)
    document.getSelection()?.removeAllRanges()
    vi.runOnlyPendingTimers()
    try {
      if (!globalThis.gc) {
        throw new Error('The test runner must enable --expose-gc')
      }
      for (let turn = 0; turn < 3; turn++) {
        await new Promise<void>((resolve) => setImmediate(resolve))
        globalThis.gc()
      }
      expect(
        refs.map((ref) => ({
          editor: !!ref.editor.deref(),
          document: !!ref.document.deref(),
          dom: !!ref.dom.deref()
        }))
      ).toEqual([
        { editor: false, document: false, dom: false },
        { editor: false, document: false, dom: false }
      ])
      expect(save).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
      held.resolve({ isBinary: true, content: btoa('late bytes'), mimeType: 'image/png' })
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    expect(save).not.toHaveBeenCalled()
  }
)
