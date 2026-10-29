import type { Editor } from '@tiptap/react'
import { completeRichMarkdownSelection } from './drag-selection-guard'

export function flushPendingProseMirrorSelection(editor: Editor): void {
  let view: Editor['view']
  try {
    view = editor.view
  } catch {
    return
  }
  // External controls consume the model once another focus owner has taken the native range.
  if (view.hasFocus()) {
    completeRichMarkdownSelection(view)
  }
}
