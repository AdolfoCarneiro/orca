// @vitest-environment happy-dom
import { Editor, type JSONContent } from '@tiptap/core'
import { afterEach, expect, it } from 'vitest'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'

const editors: Editor[] = []
function createEditor(content: string | JSONContent): Editor {
  const element = document.createElement('div')
  document.body.append(element)
  const editor = new Editor({
    element,
    extensions: createRichMarkdownExtensions({ codec: createRichMarkdownEditorCodec() }),
    content,
    ...(typeof content === 'string' ? { contentType: 'markdown' } : {})
  })
  editors.push(editor)
  return editor
}
function copy(editor: Editor): string {
  editor.commands.selectAll()
  return editor.view.serializeForClipboard(editor.state.selection.content()).dom.innerHTML
}
function paste(editor: Editor, html: string): void {
  editor.commands.selectAll()
  editor.view.pasteHTML(html)
}
afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy())
  document.getSelection()?.removeAllRanges()
  document.body.replaceChildren()
})

it.each([
  'file:///repo/notes/guide.md#section',
  'file:///C:/repo/a%20b.md#L10',
  'file://server/share/guide.md'
])('preserves %s through production rendering, HTML transfer and Markdown reopen', (uri) => {
  const source = createEditor(`Before **[guide](${uri} "Reference")** after.`)
  expect(source.view.dom.querySelector('a')?.getAttribute('href')).toBe(uri)
  const original = source.getMarkdown()
  const html = copy(source)
  expect(html).toContain(`href="${uri}"`)
  expect(source.getMarkdown()).toBe(original)
  source.destroy()
  const target = createEditor('Replace me.')
  paste(target, html)
  expect(target.view.dom.querySelector('a')?.getAttribute('href')).toBe(uri)
  expect(target.view.dom.querySelector('strong')?.textContent).toBe('guide')
  expect(target.view.dom.querySelector('a')?.getAttribute('title')).toBe('Reference')
  const reopened = createEditor(target.getMarkdown())
  expect(reopened.view.dom.querySelector('a')?.getAttribute('href')).toBe(uri)
  expect(reopened.getMarkdown()).toBe(target.getMarkdown())
  expect(target.commands.undo()).toBe(true)
  expect(target.getMarkdown()).toBe('Replace me.')
})

it.each(['javascript:alert(1)', 'data:text/html;base64,PGgxPmJhZDwvaDE+', 'vbscript:msgbox(1)'])(
  'keeps %s unavailable through rendering and paste',
  (uri) => {
    const source = createEditor({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'guide', marks: [{ type: 'link', attrs: { href: uri } }] }
          ]
        }
      ]
    })
    expect(source.view.dom.querySelector('a')?.getAttribute('href')).toBe('')
    const target = createEditor('')
    paste(target, copy(source))
    expect(target.view.dom.querySelector('a')).toBeNull()
    expect(target.getText()).toBe('guide')
  }
)

it.each(['https://example.com/guide', 'mailto:author@example.com', '#section'])(
  'preserves ordinary %s links alongside file URI support',
  (uri) => {
    const source = createEditor(`[guide](${uri})`)
    const target = createEditor('')
    paste(target, copy(source))
    expect(target.view.dom.querySelector('a')?.getAttribute('href')).toBe(uri)
  }
)
