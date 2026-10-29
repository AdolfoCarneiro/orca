// @vitest-environment happy-dom
import { Editor } from '@tiptap/react'
import type { JSONContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import { Markdown } from '@tiptap/markdown'
import { TableKit } from '@tiptap/extension-table'
import { CellSelection } from '@tiptap/pm/tables'
import { DOMParser } from '@tiptap/pm/model'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type * as ImageBlobPng from '@/lib/image-blob-png'
import { SaveImageAsTempFile } from '../../../../shared/rpc-contract/clipboard-params'
import type { RuntimeRpcRequest } from '@/runtime/runtime-file-client-test-harness'
import { handleRichMarkdownPaste } from './rich-markdown-paste-handler'
import { setRichMarkdownImageResolverContext } from './rich-markdown-image-context'
import { RichMarkdownImageClipboard } from './rich-markdown-image-clipboard'

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
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() }
}))

const editors: Editor[] = []
const files = new Map<string, string>()
async function readSourceFile({ filePath }: { filePath: string }) {
  const content = files.get(filePath)
  if (!content) {
    throw new Error('Missing source image')
  }
  return { isBinary: true, content, mimeType: 'image/png' }
}
const read = vi.fn(readSourceFile)
const save = vi.fn(async (request: RuntimeRpcRequest) => {
  if (request.method !== 'clipboard.saveImageAsTempFile') {
    throw new Error(request.method)
  }
  const { contentBase64 } = SaveImageAsTempFile.parse(request.params)
  const path = `/tmp/copy-${save.mock.calls.length}.png`
  files.set(path, contentBase64)
  return { ok: true, result: path }
})
const copy = vi.fn(async (args: { sourcePaths: string[]; destDir: string }) => ({
  results: args.sourcePaths.map((sourcePath) => {
    const bytes = files.get(sourcePath)
    if (!bytes) {
      throw new Error('Missing staged image')
    }
    const destPath = `${args.destDir}/${sourcePath.split('/').at(-1)}`
    files.set(destPath, bytes)
    return { sourcePath, destPath, status: 'imported', kind: 'file', renamed: false }
  })
}))

function createEditor(content: string | JSONContent, filePath = '/source/note.md'): Editor {
  const element = document.createElement('div')
  document.body.append(element)
  const editor = new Editor({
    element,
    extensions: [
      StarterKit,
      Image.configure({ inline: true, allowBase64: true }),
      RichMarkdownImageClipboard,
      TableKit,
      Markdown
    ],
    content,
    ...(typeof content === 'string' ? { contentType: 'markdown' } : {})
  })
  editors.push(editor)
  setRichMarkdownImageResolverContext(editor, { filePath })
  return editor
}

function serialize(editor: Editor): string {
  editor.commands.selectAll()
  return editor.view.serializeForClipboard(editor.state.selection.content()).dom.innerHTML
}

function paste(editor: Editor, html: string, filePath = '/target/note.md'): void {
  const container = document.createElement('div')
  container.innerHTML = html
  const clipboardData = new DataTransfer()
  clipboardData.setData('text/html', html)
  const event = new ClipboardEvent('paste', { clipboardData, cancelable: true })
  const slice = DOMParser.fromSchema(editor.schema).parseSlice(container)
  if (
    !handleRichMarkdownPaste({ editor, event, filePath, worktreeId: '', slice, view: editor.view })
  ) {
    expect(event.defaultPrevented).toBe(false)
    editor.view.dispatch(editor.state.tr.replaceSelection(slice).setMeta('uiEvent', 'paste'))
  }
}

function updated(editor: Editor): Promise<void> {
  return new Promise((resolve) => editor.once('update', () => resolve()))
}

beforeEach(() => {
  vi.clearAllMocks()
  read.mockReset().mockImplementation(readSourceFile)
  files.clear()
  files.set('/source/image.png', btoa('original image bytes'))
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { fs: { readFile: read, importExternalPaths: copy }, runtime: { call: save } }
  })
})
afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy())
  document.body.replaceChildren()
  vi.useRealTimers()
})

it('imports a closed source selection once, preserves its marks and image attributes, and undoes it', async () => {
  const source = createEditor('**caption** ![first](image.png "one") and ![second](image.png)')
  const html = serialize(source)
  expect(html).toContain('src="image.png"')
  expect(html).toContain('data-orca-image-clipboard-origin=')
  expect(source.getMarkdown()).not.toContain('clipboard-origin')
  source.destroy()
  const target = createEditor('left right', '/target/note.md')
  target.commands.setTextSelection(6)
  const done = updated(target)
  paste(target, html)
  await done
  expect(read).toHaveBeenCalledOnce()
  expect(read.mock.calls[0][0]).toEqual({
    filePath: '/source/image.png',
    connectionId: undefined,
    access: { kind: 'document-resource', documentPath: '/source/note.md' }
  })
  expect(files.get('/target/copy-1.png')).toBe(files.get('/source/image.png'))
  expect(target.getMarkdown()).toBe(
    'left **caption** ![first](copy-1.png "one") and ![second](copy-1.png)right'
  )
  const reopened = createEditor(target.getMarkdown(), '/target/note.md')
  expect(reopened.getJSON()).toEqual(target.getJSON())
  expect(target.commands.undo()).toBe(true)
  expect(target.getMarkdown()).toBe('left right')
  expect(toast.error).not.toHaveBeenCalled()
})

it.each([
  ['/source/note.md', '/source/another.md'],
  ['C:\\Notes\\note.md', 'c:\\notes\\another.md']
])(
  'keeps references without reading or importing within the same owner directory: %s',
  (from, to) => {
    const source = createEditor('before ![image](image.png)', from)
    const target = createEditor('', to)
    paste(target, serialize(source), to)
    expect(target.getMarkdown()).toBe('before ![image](image.png)')
    expect(read).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
  }
)

it.each(['unknown origin', 'substituted path', 'conflicting owners', 'older clipboard'])(
  'keeps ordinary paste behavior without source reads for %s',
  (kind) => {
    const source = createEditor('before ![image](image.png)')
    let html = serialize(source)
    if (kind === 'unknown origin') {
      html = html.replace(
        /data-orca-image-clipboard-origin="[^"]+"/g,
        'data-orca-image-clipboard-origin="unrecognized"'
      )
    } else if (kind === 'substituted path') {
      html = html.replace('src="image.png"', 'src="private.png"')
    } else if (kind === 'conflicting owners') {
      html += serialize(createEditor('before ![image](image.png)', '/another/note.md'))
    } else {
      html = html.replace(/ data-orca-image-clipboard-origin="[^"]+"/g, '')
    }
    const target = createEditor('', '/target/note.md')
    paste(target, html)
    expect(target.getMarkdown()).toContain(
      kind === 'substituted path' ? 'private.png' : 'image.png'
    )
    expect(read).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
  }
)

it('bounds clipboard history while retaining the latest origin', async () => {
  const source = createEditor('before ![image](image.png)')
  const oldest = serialize(source)
  let latest = ''
  for (let count = 0; count < 16; count++) {
    latest = serialize(source)
  }
  const target = createEditor('', '/target/note.md')
  paste(target, oldest)
  expect(target.getMarkdown()).toBe('before ![image](image.png)')
  expect(read).not.toHaveBeenCalled()
  const done = updated(target)
  paste(target, latest)
  await done
  expect(read).toHaveBeenCalledOnce()
  expect(target.getMarkdown()).toContain('copy-1.png')
})

it.each(['image count', 'source characters'])(
  'falls back for the entire copy when its %s budget is exceeded',
  (kind) => {
    const markdown =
      kind === 'image count'
        ? `before ${Array.from({ length: 257 }, (_, index) => `![image-${index}](${index}.png)`).join(' ')}`
        : `before ![one](image.png) ![two](${'x'.repeat(32768)}.png)`
    const source = createEditor(markdown)
    const html = serialize(source)
    const target = createEditor('', '/target/note.md')
    paste(target, html)
    expect(target.getJSON()).toEqual(source.getJSON())
    expect(read).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
  }
)

it.each(['plain text', 'https://example.com/image.png', 'data:image/png;base64,eA=='])(
  'does not capture the document owner when copying %s',
  (content) => {
    const source = createEditor(content === 'plain text' ? content : `before ![image](${content})`)
    const imageStorage: unknown = 'image' in source.storage ? source.storage.image : undefined
    if (!imageStorage || typeof imageStorage !== 'object') {
      throw new Error('Missing image storage')
    }
    Object.defineProperty(imageStorage, 'filePath', {
      configurable: true,
      get: () => {
        throw new Error('Unnecessary document owner capture')
      }
    })
    const html = serialize(source)
    expect(html).not.toContain('clipboard-origin')
    if (content !== 'plain text') {
      expect(html).toContain('<img')
    }
  }
)

async function closeCopiedEditorsWhileReading(started: Promise<void>) {
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
  paste(target, html)
  await started
  for (const owner of [source, target]) {
    const dom = owner.view.dom.parentElement
    owner.destroy()
    dom?.remove()
    editors.splice(editors.indexOf(owner), 1)
  }
  return refs
}

it('releases both closed editors while the original image read remains pending', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const held = Promise.withResolvers<{ isBinary: boolean; content: string; mimeType: string }>()
  const started = Promise.withResolvers<void>()
  read.mockImplementationOnce(() => {
    started.resolve()
    return held.promise
  })
  const refs = await closeCopiedEditorsWhileReading(started.promise)
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
})

it('preserves native table-paste geometry and Undo when importing a copied image cell', async () => {
  const source = createEditor(
    '| ![image](image.png) | caption |\n| --- | --- |\n| first | second |'
  )
  const html = serialize(source)
  const content =
    '| A | B | C |\n| --- | --- | --- |\n| one | two | keep |\n| three | four | stay |'
  const target = createEditor(content, '/target/note.md')
  const ordinary = createEditor(content, '/target/note.md')
  for (const editor of [target, ordinary]) {
    const positions = new Map<string, number>()
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'tableCell') {
        positions.set(node.textContent, pos)
      }
    })
    const first = positions.get('one'),
      last = positions.get('four')
    if (first === undefined || last === undefined) {
      throw new Error('Missing target cells')
    }
    editor.view.dispatch(
      editor.state.tr.setSelection(CellSelection.create(editor.state.doc, first, last))
    )
  }
  const before = target.getJSON()
  expect(ordinary.view.pasteHTML(html.replace('src="image.png"', 'src="copy-1.png"'))).toBe(true)
  const done = updated(target)
  paste(target, html)
  await done
  expect(target.getJSON()).toEqual(ordinary.getJSON())
  expect(read).toHaveBeenCalledOnce()
  expect(target.commands.undo()).toBe(true)
  expect(target.getJSON()).toEqual(before)
})
