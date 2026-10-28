// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildRichMarkdownCommentBlocks,
  getRichMarkdownCommentBlocks
} from './rich-markdown-comment-blocks'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'

const editors: Editor[] = []

function createEditor(source: string) {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: createRichMarkdownExtensions({ codec: createRichMarkdownEditorCodec() }),
    content: source,
    contentType: 'markdown'
  })
  editors.push(editor)
  return editor
}

afterEach(() => {
  for (const editor of editors.splice(0)) {
    editor.destroy()
  }
  vi.restoreAllMocks()
})

describe('review source block serialization after edits', () => {
  it.each([100, 1_000])(
    'serializes only the edited block and its two pairs among %i blocks',
    (count) => {
      const editor = createEditor(
        Array.from({ length: count }, (_, index) => `paragraph ${index}`).join('\n\n')
      )
      const serialize = vi.spyOn(editor.markdown!, 'serialize')
      expect(getRichMarkdownCommentBlocks(editor)).toEqual(buildRichMarkdownCommentBlocks(editor))
      serialize.mockClear()
      let position = 0
      editor.state.doc.forEach((_node, offset, index) => {
        if (index === Math.floor(count / 2)) {
          position = offset + 1
        }
      })
      editor.view.dispatch(editor.state.tr.insertText('edited ', position))
      const actual = getRichMarkdownCommentBlocks(editor)
      expect(serialize).toHaveBeenCalledTimes(3)
      serialize.mockClear()
      expect(actual).toEqual(buildRichMarkdownCommentBlocks(editor))
      expect(serialize).toHaveBeenCalledTimes(2 * editor.state.doc.childCount - 1)
      serialize.mockClear()
      expect(getRichMarkdownCommentBlocks(editor)).toBe(actual)
      expect(serialize).not.toHaveBeenCalled()
    }
  )

  it('preserves exact block positions through multiline edits, moves, insertions, deletion and undo', () => {
    const editor = createEditor(
      'First\n\n```text\none\ntwo\n```\n\n> quote\n>\n> second\n\n- item one\n- item two\n\nLast'
    )
    const check = () =>
      expect(getRichMarkdownCommentBlocks(editor)).toEqual(buildRichMarkdownCommentBlocks(editor))
    check()
    editor.view.dispatch(
      editor.state.tr.insertText('extra\n', editor.state.doc.child(0).nodeSize + 1)
    )
    check()
    const node = editor.state.doc.child(0)
    const move = editor.state.tr.delete(0, node.nodeSize)
    move.insert(move.doc.content.size, node)
    editor.view.dispatch(move)
    check()
    const paragraph = editor.schema.nodes.paragraph.create(null, editor.schema.text('inserted'))
    editor.view.dispatch(editor.state.tr.insert(0, paragraph))
    check()
    editor.view.dispatch(editor.state.tr.delete(0, paragraph.nodeSize))
    check()
    expect(editor.commands.undo()).toBe(true)
    check()
    expect(editor.commands.redo()).toBe(true)
    check()
  })

  it('invalidates node and pair counts when the serializer changes', () => {
    const editor = createEditor('First\n\nLast')
    getRichMarkdownCommentBlocks(editor)
    const serialize = vi.spyOn(editor.markdown!, 'serialize')
    expect(getRichMarkdownCommentBlocks(editor)).toEqual(buildRichMarkdownCommentBlocks(editor))
    expect(serialize).toHaveBeenCalledTimes(6)
  })
})
