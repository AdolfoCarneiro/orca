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
import { handleRichMarkdownImageDrop } from './rich-markdown-image-drop'

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
    ...(typeof content === 'string' ? { contentType: 'markdown' } : {}),
    editorProps: {
      handleDrop: (view, event, slice, moved) =>
        handleRichMarkdownImageDrop({ editor, view, event, slice, moved, filePath, worktreeId: '' })
    }
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

function serializeImage(editor: Editor): string {
  let imagePosition = -1
  editor.state.doc.descendants((node, position) => {
    if (node.type.name === 'image') {
      imagePosition = position
    }
  })
  if (imagePosition < 0) {
    throw new Error('Missing source image')
  }
  editor.commands.setNodeSelection(imagePosition)
  return editor.view.serializeForClipboard(editor.state.selection.content()).dom.innerHTML
}

function drop(editor: Editor, html: string, position: number, copy = false): void {
  editor.view.focus()
  const dataTransfer = new DataTransfer()
  dataTransfer.setData('text/html', html)
  const event = new DragEvent('drop', { cancelable: true })
  Object.defineProperties(event, {
    dataTransfer: { value: dataTransfer },
    clientX: { value: 50 },
    clientY: { value: 50 },
    ctrlKey: { value: copy },
    altKey: { value: copy }
  })
  const coordinates = editor.view.posAtCoords
  editor.view.posAtCoords = () => ({ pos: position, inside: -1 })
  try {
    editor.view.dispatchEvent(event)
  } finally {
    editor.view.posAtCoords = coordinates
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

it.each([
  ['paragraph', 'before after', '![image](image.png)'],
  ['list', '- before\n- after', 'caption ![image](image.png)'],
  ['table cell', '| before | after |\n| --- | --- |\n| one | two |', '![image](image.png)'],
  ['table', 'before\n\nafter', '| ![image](image.png) | caption |\n| --- | --- |\n| one | two |']
])('matches native %s drop fitting, selection and Undo', async (_kind, content, copied) => {
  const source = createEditor(copied.startsWith('![') ? `before ${copied}` : copied)
  const html = copied.startsWith('![') ? serializeImage(source) : serialize(source)
  const target = createEditor(content, '/target/note.md')
  const ordinary = createEditor(content, '/target/note.md')
  let position = -1
  target.state.doc.descendants((node, pos) => {
    if (position < 0 && node.isText) {
      position = pos + Math.min(3, node.nodeSize)
    }
  })
  if (position < 0) {
    throw new Error('Missing drop position')
  }
  const done = updated(target)
  drop(target, html, position)
  await done
  await vi.waitFor(() => expect(target.getMarkdown()).toContain('copy-1.png'))
  drop(
    ordinary,
    html
      .replaceAll('src="image.png"', 'src="copy-1.png"')
      .replace(/ data-orca-image-clipboard-origin="[^"]+"/g, ''),
    position
  )
  expect(target.getJSON()).toEqual(ordinary.getJSON())
  expect(target.state.selection.toJSON()).toEqual(ordinary.state.selection.toJSON())
  expect(read).toHaveBeenCalledOnce()
  expect(target.commands.undo()).toBe(ordinary.commands.undo())
  expect(target.getJSON()).toEqual(ordinary.getJSON())
})

it.each([false, true])('keeps same-editor native drag behavior with copy=%s', (copy) => {
  const editor = createEditor('before ![image](image.png) after')
  let imagePosition = -1
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'image') {
      imagePosition = pos
    }
  })
  editor.commands.setNodeSelection(imagePosition)
  const slice = editor.state.selection.content()
  const html = editor.view.serializeForClipboard(slice).dom.innerHTML
  editor.view.dragging = { slice, move: !copy }
  drop(editor, html, editor.state.doc.content.size - 1, copy)
  let count = 0
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'image') {
      count++
    }
  })
  expect(count).toBe(copy ? 2 : 1)
  expect(read).not.toHaveBeenCalled()
  expect(save).not.toHaveBeenCalled()
  expect(editor.commands.undo()).toBe(true)
  expect(editor.getMarkdown()).toBe('before ![image](image.png) after')
})

it('maps the actual drop position while preserving subsequent typing and its live caret', async () => {
  const source = createEditor('before ![image](image.png)')
  const html = serializeImage(source)
  const target = createEditor('left right', '/target/note.md')
  const held = Promise.withResolvers<void>()
  const started = Promise.withResolvers<void>()
  read.mockImplementationOnce(async (args) => {
    started.resolve()
    await held.promise
    return readSourceFile(args)
  })
  drop(target, html, 6)
  await started.promise
  expect(target.state.selection.from).toBe(1)
  target.commands.setTextSelection(target.state.doc.content.size - 1)
  target.commands.insertContent(' typed')
  const done = updated(target)
  held.resolve()
  await done
  expect(target.getMarkdown()).toBe('left ![image](copy-1.png)right typed')
  expect(target.state.selection.empty).toBe(true)
  expect(target.state.selection.from).toBe(target.state.doc.content.size - 1)
  expect(target.commands.undo()).toBe(true)
  expect(target.getMarkdown()).toBe('left right typed')
})

it('keeps two delayed drops in request order when their reads settle in reverse', async () => {
  const source = createEditor('before ![first](image.png)')
  const first = serializeImage(source)
  const second = serializeImage(createEditor('before ![second](second.png)'))
  files.set('/source/second.png', btoa('second image bytes'))
  const held = Promise.withResolvers<void>()
  const started = Promise.withResolvers<void>()
  read.mockImplementationOnce(async (args) => {
    started.resolve()
    await held.promise
    return readSourceFile(args)
  })
  const target = createEditor('left right', '/target/note.md')
  drop(target, first, 6)
  await started.promise
  const secondDone = updated(target)
  drop(target, second, 6)
  await secondDone
  const firstDone = updated(target)
  held.resolve()
  await firstDone
  expect(target.getMarkdown()).toBe('left ![first](copy-2.png)![second](copy-1.png)right')
  expect(read).toHaveBeenCalledTimes(2)
})

it.each(['same folder', 'unknown metadata', 'substituted path'])(
  'keeps ordinary drop behavior for %s without importing',
  (kind) => {
    const source = createEditor('caption ![image](image.png)')
    let html = serialize(source)
    if (kind === 'unknown metadata') {
      html = html.replace(
        /data-orca-image-clipboard-origin="[^"]+"/g,
        'data-orca-image-clipboard-origin="unknown"'
      )
    } else if (kind === 'substituted path') {
      html = html.replace('src="image.png"', 'src="other.png"')
    }
    const target = createEditor(
      'before after',
      kind === 'same folder' ? '/source/another.md' : '/target/note.md'
    )
    drop(target, html, 8)
    expect(target.getMarkdown()).toContain(kind === 'substituted path' ? 'other.png' : 'image.png')
    expect(read).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
  }
)
