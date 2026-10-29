// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
import { EditorState } from '@tiptap/pm/state'
import { DecorationSet } from '@tiptap/pm/view'
import StarterKit from '@tiptap/starter-kit'
import { afterEach, expect, it } from 'vitest'
import { NativeChatUnkernedRunDecorations } from './native-chat-unkerned-run-decorations'
import { promptTextContent } from './native-chat-prompt-document'

let editor: Editor | null = null
afterEach(() => editor?.destroy())

it('keeps a keystroke cheap in a draft with thousands of unkerned lines', () => {
  editor = new Editor({ extensions: [StarterKit, NativeChatUnkernedRunDecorations] })
  const line = 'x'.repeat(300)
  let state = EditorState.create({
    doc: editor.schema.nodeFromJSON(
      promptTextContent(Array.from({ length: 8000 }, () => line).join('\n'))
    ),
    plugins: editor.extensionManager.plugins
  })
  const decorations = () =>
    state.plugins.flatMap((plugin) => {
      const set = plugin.props.decorations?.call(plugin, state)
      return set instanceof DecorationSet ? set.find() : []
    })
  expect(decorations()).toHaveLength(8000)
  const type = (keys: number) => {
    for (let key = 0; key < keys; key++) {
      state = state.apply(state.tr.insertText('y', state.doc.content.size - 1))
    }
  }
  type(20)
  // Why: a full rebuild costs O(lines x decorations), ~190 ms a key here; an incremental one ~1 ms.
  const started = performance.now()
  type(50)
  expect((performance.now() - started) / 50).toBeLessThan(15)
  expect(decorations()).toHaveLength(8000)
})
