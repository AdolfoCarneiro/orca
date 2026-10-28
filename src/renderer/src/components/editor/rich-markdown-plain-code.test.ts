// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { common, createLowlight } from 'lowlight'
import { afterEach, expect, it, vi } from 'vitest'
import { RichMarkdownCodeBlockLowlight } from './rich-markdown-lowlight'

const editors: Editor[] = []
afterEach(() => editors.splice(0).forEach((editor) => editor.destroy()))

function mount(language: string | null, defaultLanguage: string | null = null) {
  const lowlight = createLowlight(common)
  const named = vi.spyOn(lowlight, 'highlight')
  const automatic = vi.spyOn(lowlight, 'highlightAuto')
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: [
      StarterKit.configure({ codeBlock: false, trailingNode: false }),
      RichMarkdownCodeBlockLowlight.configure({ lowlight, defaultLanguage })
    ],
    content: {
      type: 'doc',
      content: [
        {
          type: 'codeBlock',
          attrs: { language },
          content: [{ type: 'text', text: 'const answer = 42;' }]
        }
      ]
    }
  })
  editors.push(editor)
  const spans = () => editor.view.dom.querySelectorAll('[class*="hljs-"]').length
  return { editor, named, automatic, spans }
}

it.each([null, ''])('keeps Plain text (%j) uncolored on load and edits', (language) => {
  const { editor, named, automatic, spans } = mount(language)
  expect(spans()).toBe(0)
  expect(named).not.toHaveBeenCalled()
  expect(automatic).not.toHaveBeenCalled()
  editor.view.dispatch(editor.state.tr.insertText('changed ', 1))
  expect(editor.state.doc.textContent).toBe('changed const answer = 42;')
  expect(editor.state.doc.firstChild?.attrs.language).toBe(language)
  expect(spans()).toBe(0)
  expect(named).not.toHaveBeenCalled()
  expect(automatic).not.toHaveBeenCalled()
})

it('removes syntax colors when choosing Plain text and restores them through undo', () => {
  const { editor, automatic, spans } = mount('javascript')
  expect(spans()).toBeGreaterThan(0)
  editor.view.dispatch(editor.state.tr.setNodeMarkup(0, undefined, { language: '' }))
  expect(spans()).toBe(0)
  expect(editor.state.doc.textContent).toBe('const answer = 42;')
  expect(editor.commands.undo()).toBe(true)
  expect(editor.state.doc.firstChild?.attrs.language).toBe('javascript')
  expect(spans()).toBeGreaterThan(0)
  expect(editor.commands.redo()).toBe(true)
  expect(spans()).toBe(0)
  expect(automatic).not.toHaveBeenCalled()
})

it.each([
  ['javascript', null],
  ['js', null],
  [null, 'javascript'],
  ['', 'javascript']
])('preserves named and configured-default highlighting for %j / %j', (language, fallback) => {
  const { named, automatic, spans } = mount(language, fallback)
  expect(named).toHaveBeenCalledTimes(1)
  expect(automatic).not.toHaveBeenCalled()
  expect(spans()).toBeGreaterThan(0)
})

it('preserves automatic fallback for an explicit unknown language', () => {
  const { automatic, spans } = mount('unknown-language')
  expect(automatic).toHaveBeenCalledTimes(1)
  expect(spans()).toBeGreaterThan(0)
})
