import type { Editor } from '@tiptap/react'

export const RICH_MARKDOWN_CODE_BLOCK_INDENT = '  '

const LEADING_INDENT = /^(\t| {1,2})/

function changeCodeBlockIndent(editor: Editor, direction: 'indent' | 'outdent'): boolean {
  const { from, to, empty } = editor.state.selection
  if (empty && direction === 'indent') {
    return false
  }
  const tr = editor.state.tr
  editor.state.doc.nodesBetween(from, to, (node, position) => {
    if (node.type.name !== 'codeBlock') {
      return true
    }
    let lineStart = position + 1
    for (const line of node.textContent.split('\n')) {
      const lineEnd = lineStart + line.length
      const isTouched = lineEnd >= from && (empty ? lineStart <= to : lineStart < to)
      if (isTouched) {
        const start = tr.mapping.map(lineStart)
        if (direction === 'indent') {
          tr.insertText(RICH_MARKDOWN_CODE_BLOCK_INDENT, start)
        } else {
          const indent = LEADING_INDENT.exec(line)
          if (indent) {
            tr.delete(start, tr.mapping.map(lineStart + indent[0].length))
          }
        }
      }
      lineStart = lineEnd + 1
    }
    return false
  })
  if (!tr.docChanged) {
    return false
  }
  editor.view.dispatch(tr)
  return true
}

export function indentRichMarkdownCodeBlock(editor: Editor): boolean {
  if (editor.state.selection.empty) {
    return editor.commands.insertContent(RICH_MARKDOWN_CODE_BLOCK_INDENT)
  }
  return changeCodeBlockIndent(editor, 'indent')
}

export function outdentRichMarkdownCodeBlock(editor: Editor): boolean {
  return changeCodeBlockIndent(editor, 'outdent')
}
