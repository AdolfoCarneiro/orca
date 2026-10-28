// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { createRichMarkdownEditorDocument } from './create-rich-markdown-editor-document'
import { RICH_MARKDOWN_EDITOR_MARKUP } from './document-markup'
import { quietRichMarkdownEditorHost } from './rich-markdown-editor-host.test-support'
import type { RichMarkdownEditorDocument } from './document-host-seams'
import type { MobileRichMarkdownEditorMessage } from '../mobile-rich-markdown-editor-contract'

let mounted: RichMarkdownEditorDocument | undefined

afterEach(() => {
  mounted?.stop()
  mounted = undefined
  document.body.innerHTML = ''
})

function open(markdown: string) {
  document.body.innerHTML = RICH_MARKDOWN_EDITOR_MARKUP
  const messages: MobileRichMarkdownEditorMessage[] = []
  const editorDocument = createRichMarkdownEditorDocument(
    quietRichMarkdownEditorHost({ postToHost: (message) => messages.push(message) })
  )
  mounted = editorDocument
  editorDocument.send.setMarkdown(markdown, 7)
  return { editorDocument, messages, editor: document.getElementById('editor')! }
}

const contexts = [
  { name: 'bullet', source: '- Intro\n- Next\n\nOutside', selector: 'li' },
  { name: 'ordered', source: '10. Intro\n11. Next\n\nOutside', selector: 'li' },
  { name: 'task', source: '- [x] Intro\n- [ ] Next\n\nOutside', selector: 'li > div' },
  {
    name: 'nested ordered',
    source: '- Parent\n  3. Intro\n  4. Next\n- Last\n\nOutside',
    selector: 'ol li'
  }
]

describe('mobile list code blocks', () => {
  it.each(contexts)(
    'preserves literal code and continuation paragraphs in $name items',
    ({ source, selector }) => {
      const { editorDocument, messages, editor } = open(source)
      const body = editor.querySelector(selector)!
      body.innerHTML =
        '<p>Before <strong>bold</strong><br>continued</p><pre data-language="js"><code></code></pre><p>After <em>tail</em></p>'
      const code = '  indented\n\ttab\n\t\n    \n\n````\n<tag>&amp; &#60;\n\n'
      body.querySelector('code')!.textContent = code
      const before = body.innerHTML
      messages.length = 0
      editor.dispatchEvent(new Event('input'))
      const saved = editorDocument.send.currentMarkdown()
      expect(body.innerHTML).toBe(before)
      expect(messages).toEqual([{ type: 'change', markdown: saved, generation: 7 }])
      editorDocument.send.setMarkdown(saved, 8)
      const reopened = editor.querySelector(selector)!
      expect(reopened.querySelector('pre')?.textContent).toBe(code)
      expect(reopened.querySelector('pre')?.getAttribute('data-language')).toBe('js')
      expect(Array.from(reopened.querySelectorAll('p')).map((node) => node.textContent)).toEqual([
        'Before boldcontinued',
        'After tail'
      ])
      expect(reopened.querySelector('p br')).not.toBeNull()
      expect(reopened.querySelector('strong')?.textContent).toBe('bold')
      expect(reopened.querySelector('em')?.textContent).toBe('tail')
      expect(editor.querySelector(':scope > p')?.textContent).toBe('Outside')
      expect(editorDocument.send.currentMarkdown()).toBe(saved)
    }
  )

  it.each([
    { source: '- Intro\n\n  ```js\n  code\n  ```\n\n  After\n- Next', selector: 'li' },
    { source: '10. Intro\n\n    ```js\n    code\n    ```\n\n    After\n11. Next', selector: 'li' },
    {
      source: '- [x] Intro\n\n  ```js\n  code\n  ```\n\n  After\n- [ ] Next',
      selector: 'li > div'
    },
    {
      source: '- Parent\n  3. Intro\n\n     ```js\n     code\n     ```\n\n     After\n  4. Next',
      selector: 'ol li'
    }
  ])(
    'reads an indented fenced block and keeps its following paragraph inside the item',
    ({ source, selector }) => {
      const { editorDocument, editor } = open(source)
      const body = editor.querySelector(selector)!
      expect(body.querySelector('pre')?.textContent).toBe('code')
      expect(Array.from(body.querySelectorAll('p')).map((node) => node.textContent)).toEqual([
        'Intro',
        'After'
      ])
      const saved = editorDocument.send.currentMarkdown()
      editorDocument.send.setMarkdown(saved, 8)
      expect(editor.querySelector(selector)?.querySelector('pre')?.textContent).toBe('code')
      expect(editorDocument.send.currentMarkdown()).toBe(saved)
    }
  )

  it('keeps an explicit empty task paragraph before code and retains checked state', () => {
    const { editorDocument, editor } = open('- [x] Intro\n- [ ] Next')
    const body = editor.querySelector('li > div')!
    body.innerHTML = '<p><br></p><pre data-language=""><code>literal</code></pre><p>After</p>'
    const saved = editorDocument.send.currentMarkdown()
    editorDocument.send.setMarkdown(saved, 8)
    expect(editor.querySelector('li > label input')?.hasAttribute('checked')).toBe(true)
    expect(editor.querySelector('li > div > p > br')).not.toBeNull()
    expect(editor.querySelector('li pre')?.textContent).toBe('literal')
    expect(editorDocument.send.currentMarkdown()).toBe(saved)
  })
})
