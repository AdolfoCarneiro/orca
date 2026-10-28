// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { CellSelection } from '@tiptap/pm/tables'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { runRichMarkdownTableAction } from './rich-markdown-table-actions'

function createEditor(widths?: readonly number[]): Editor {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: createRichMarkdownExtensions({ codec: createRichMarkdownEditorCodec() }),
    content: '| A | B |\n| --- | --- |\n| a1 | b1 |\n| a2 | b2 |\n',
    contentType: 'markdown'
  })
  const row = editor.state.doc.firstChild?.firstChild
  if (widths && row) {
    const transaction = editor.state.tr
    row.forEach((cell, offset, index) => {
      transaction.setNodeMarkup(2 + offset, undefined, { ...cell.attrs, colwidth: [widths[index]] })
    })
    editor.view.dispatch(transaction)
  }
  return editor
}

function cellAtText(editor: Editor, text: string): number {
  let position: number | undefined
  editor.state.doc.descendants((node, pos) => {
    const role = node.type.spec.tableRole
    if (role === 'cell' || role === 'header_cell') {
      if (node.textContent === text) {
        position = pos
      }
      return false
    }
    return true
  })
  if (position === undefined) {
    throw new Error(`Expected cell text: ${text}`)
  }
  return position
}

function firstRowColumnWidths(editor: Editor): number[] {
  const widths: number[] = []
  editor.state.doc.firstChild?.firstChild?.forEach((cell) => {
    widths.push(cell.attrs.colwidth?.[0] ?? 0)
  })
  return widths
}

describe('rich markdown table column widths', () => {
  it.each([
    ['insert-column-left', 'b2', false, [100, 133, 67]],
    ['insert-column-right', 'a1', false, [133, 67, 100]],
    ['insert-column-left', 'b2', true, [100, 133, 67]],
    ['insert-column-right', 'a1', true, [133, 67, 100]]
  ] as const)(
    'preserves locked widths for %s through selected cell %s (reversed: %s)',
    (action, target, reversed, expectedWidths) => {
      const editor = createEditor([200, 100])
      try {
        const first = cellAtText(editor, 'a1')
        const last = cellAtText(editor, 'b2')
        editor.view.dispatch(
          editor.state.tr.setSelection(
            CellSelection.create(editor.state.doc, reversed ? last : first, reversed ? first : last)
          )
        )

        expect(
          runRichMarkdownTableAction(editor, action, { cellPosition: cellAtText(editor, target) })
        ).toBe(true)

        expect(firstRowColumnWidths(editor)).toEqual(expectedWidths)
        expect(editor.state.selection).toBeInstanceOf(CellSelection)
        expect(editor.commands.undo()).toBe(true)
        expect(editor.state.doc.firstChild?.firstChild?.childCount).toBe(2)
      } finally {
        editor.destroy()
      }
    }
  )

  it.each(['insert-column-left', 'insert-column-right'] as const)(
    'keeps widths unset for %s beside a selected rectangle',
    (action) => {
      const editor = createEditor()
      try {
        const first = cellAtText(editor, 'a1')
        const last = cellAtText(editor, 'b2')
        editor.view.dispatch(
          editor.state.tr.setSelection(CellSelection.create(editor.state.doc, first, last))
        )

        expect(runRichMarkdownTableAction(editor, action, { cellPosition: last })).toBe(true)

        expect(firstRowColumnWidths(editor)).toEqual([0, 0, 0])
      } finally {
        editor.destroy()
      }
    }
  )
})
