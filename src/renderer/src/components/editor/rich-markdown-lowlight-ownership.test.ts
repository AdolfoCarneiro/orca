// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
import { DecorationSet } from '@tiptap/pm/view'
import StarterKit from '@tiptap/starter-kit'
import { common, createLowlight } from 'lowlight'
import { afterEach, expect, it, vi } from 'vitest'
import { RichMarkdownCodeBlockLowlight } from './rich-markdown-lowlight'

const editors: Editor[] = []
afterEach(() => editors.splice(0).forEach((editor) => editor.destroy()))

it.each([0, 1, 2])('owns one highlighting plugin through %i extension layers', (depth) => {
  let extension = RichMarkdownCodeBlockLowlight
  for (let index = 0; index < depth; index += 1) {
    extension = extension.extend({})
  }
  const lowlight = createLowlight(common)
  const highlight = vi.spyOn(lowlight, 'highlight')
  const languages = vi.spyOn(lowlight, 'listLanguages')
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: [
      StarterKit.configure({ codeBlock: false, trailingNode: false }),
      extension.configure({ lowlight })
    ],
    content: '<pre><code class="language-javascript">const answer = 42;</code></pre>'
  })
  editors.push(editor)
  const highlightingStates = () =>
    editor.state.plugins.flatMap((plugin) => {
      const state: unknown = plugin.getState(editor.state)
      return state instanceof DecorationSet ? [state] : []
    })
  expect(highlightingStates()).toHaveLength(1)
  expect(highlightingStates()[0].find().length).toBeGreaterThan(0)
  expect(highlight).toHaveBeenCalledTimes(1)
  expect(languages).toHaveBeenCalledTimes(1)
  const before = editor.state.doc.textContent
  highlight.mockClear()
  editor.view.dispatch(editor.state.tr.insertText('changed ', 1))
  expect(editor.state.doc.textContent).toBe(`changed ${before}`)
  expect(highlightingStates()).toHaveLength(1)
  expect(highlight).toHaveBeenCalledTimes(1)
  expect(editor.commands.undo()).toBe(true)
  expect(editor.state.doc.textContent).toBe(before)
  expect(highlightingStates()).toHaveLength(1)
})

it.each([0, 1, 2])('preserves VS Code paste through %i extension layers', (depth) => {
  let extension = RichMarkdownCodeBlockLowlight
  for (let index = 0; index < depth; index += 1) {
    extension = extension.extend({})
  }
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: [
      StarterKit.configure({ codeBlock: false, trailingNode: false }),
      extension.configure({ lowlight: createLowlight(common) })
    ],
    content: '<p>Before</p>'
  })
  editors.push(editor)
  editor.commands.selectAll()
  const clipboardData = new DataTransfer()
  clipboardData.setData('text/plain', 'const answer = 42;\r\nconsole.log(answer);')
  clipboardData.setData('vscode-editor-data', JSON.stringify({ mode: 'javascript' }))
  const event = new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true })
  editor.view.dom.dispatchEvent(event)
  expect(event.defaultPrevented).toBe(true)
  expect(editor.state.doc.firstChild?.type.name).toBe('codeBlock')
  expect(editor.state.doc.firstChild?.attrs.language).toBe('javascript')
  expect(editor.state.doc.textContent).toBe('const answer = 42;\nconsole.log(answer);')
})
