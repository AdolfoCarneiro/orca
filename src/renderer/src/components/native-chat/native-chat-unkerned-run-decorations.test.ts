// @vitest-environment happy-dom
import { Editor, type JSONContent } from '@tiptap/core'
import { EditorState } from '@tiptap/pm/state'
import { DecorationSet, type Decoration } from '@tiptap/pm/view'
import StarterKit from '@tiptap/starter-kit'
import { afterEach, expect, it } from 'vitest'
import { NativeChatUnkernedRunDecorations } from './native-chat-unkerned-run-decorations'

let editor: Editor | null = null
afterEach(() => {
  editor?.destroy()
  editor = null
})

function decorations(state: EditorState): Decoration[] {
  return state.plugins.flatMap((plugin) => {
    const set = plugin.props.decorations?.call(plugin, state)
    return set instanceof DecorationSet ? set.find() : []
  })
}

const ranges = (state: EditorState) => decorations(state).map(({ from, to }) => [from, to])

// One block of long runs split by spaces and Shift+Enter breaks, as a pasted log can be.
function longRunBlock(runs: number): JSONContent {
  return {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: Array.from({ length: runs }, (_, index): JSONContent[] => [
          { type: 'text', text: `${'x'.repeat(300)}${index % 2 ? ' ' : ''}` },
          ...(index % 2 ? [] : [{ type: 'hardBreak' }])
        ]).flat()
      }
    ]
  }
}

it('re-checks only the edited run of a long block and agrees with a full scan', () => {
  editor = new Editor({ extensions: [StarterKit, NativeChatUnkernedRunDecorations] })
  const { plugins } = editor.extensionManager
  const before = EditorState.create({
    doc: editor.schema.nodeFromJSON(longRunBlock(2000)),
    plugins
  })
  const old = decorations(before)
  expect(old).toHaveLength(2000)
  const edited = old[1000]
  const after = before.apply(before.tr.insertText(' ', edited.from + 150))
  const kept = decorations(after)
  expect(kept).toHaveLength(1999)
  const oldSpecs = new Set(old.map((decoration) => decoration.spec))
  expect(kept.every((decoration) => oldSpecs.has(decoration.spec))).toBe(true)
  expect(kept.some((decoration) => decoration.spec === edited.spec)).toBe(false)
  expect(ranges(after)).toEqual(ranges(EditorState.create({ doc: after.doc, plugins })))
})

it('waits for an IME composition to end before redecorating, then rescans', async () => {
  const element = document.createElement('div')
  editor = new Editor({
    element,
    extensions: [StarterKit, NativeChatUnkernedRunDecorations],
    content: `<p>${'x'.repeat(400)}</p>`
  })
  const { view } = editor
  const unkerned = () => element.querySelectorAll('[style*="font-kerning"]').length
  expect(unkerned()).toBe(1)
  view.dispatch(view.state.tr.insertText(' ', 200).setMeta('composition', 1))
  expect(unkerned()).toBe(1)
  view.dom.dispatchEvent(new Event('compositionend'))
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(unkerned()).toBe(0)
  expect(ranges(view.state)).toEqual([])
})
