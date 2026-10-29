import type { Editor } from '@tiptap/core'
import type { Slice } from '@tiptap/pm/model'
import type { EditorView } from '@tiptap/pm/view'
import { dropPoint } from '@tiptap/pm/transform'
import { handleRichMarkdownHtmlImageImport } from './rich-markdown-html-image-import'

type RichMarkdownImageDropArgs = {
  editor: Editor | null
  view: EditorView
  event: DragEvent
  slice: Slice
  moved: boolean
  filePath: string
  worktreeId: string
  runtimeEnvironmentId?: string | null
}

export function handleRichMarkdownImageDrop({
  editor,
  view,
  event,
  slice,
  moved,
  filePath,
  worktreeId,
  runtimeEnvironmentId
}: RichMarkdownImageDropArgs): boolean {
  if (!editor || moved || view.dragging || !event.dataTransfer) {
    return false
  }
  const html = event.dataTransfer.getData('text/html')
  if (!html.includes('blob:') && !html.includes('data-orca-image-clipboard-origin')) {
    return false
  }
  const coordinates = view.posAtCoords({ left: event.clientX, top: event.clientY })
  if (!coordinates) {
    return false
  }
  const handled = handleRichMarkdownHtmlImageImport({
    editor,
    event,
    html,
    filePath,
    worktreeId,
    runtimeEnvironmentId,
    slice,
    dropPosition: dropPoint(view.state.doc, coordinates.pos, slice) ?? coordinates.pos
  })
  if (handled) {
    view.focus()
  }
  return handled
}
