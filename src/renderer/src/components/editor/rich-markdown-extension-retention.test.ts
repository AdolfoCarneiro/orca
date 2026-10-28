// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { expect, it } from 'vitest'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'

type ClosedMarkdownOwner = {
  editor: WeakRef<Editor>
  document: WeakRef<ProseMirrorNode>
}

function closeMarkdownEditors(count: number): ClosedMarkdownOwner[] {
  const closed: ClosedMarkdownOwner[] = []
  const source = Array.from(
    { length: 100 },
    (_, index) => `_Block ${index} ${'x'.repeat(1024)}_`
  ).join('\n\n')
  for (let index = 0; index < count; index++) {
    const codec = createRichMarkdownEditorCodec()
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: createRichMarkdownExtensions({ codec }),
      content: encodeRawMarkdownHtmlForRichEditor(source, codec),
      contentType: 'markdown'
    })
    try {
      closed.push({
        editor: new WeakRef(editor),
        document: new WeakRef(editor.state.doc)
      })
    } finally {
      editor.destroy()
    }
  }
  return closed
}

async function collect(): Promise<void> {
  if (typeof globalThis.gc !== 'function') {
    throw new Error('Run with the repository Vitest --expose-gc config')
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  for (let round = 0; round < 4; round++) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    globalThis.gc()
  }
}

it.each([1, 8])(
  'releases the final destroyed Markdown owner after closing %i editors',
  async (count) => {
    const closed = closeMarkdownEditors(count)
    await collect()
    for (const owner of closed) {
      expect(owner.editor.deref()).toBeUndefined()
      expect(owner.document.deref()).toBeUndefined()
    }
  }
)
