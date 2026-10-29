import type { editor } from 'monaco-editor'

type ScrollableEditor = Pick<editor.ICodeEditor, 'setScrollTop'>

// Windowed combined-diff editors move the shared list only for user-driven scrolls; Monaco's own layout scrolls stay local.
const intentionalScrollEditors = new WeakSet<ScrollableEditor>()

export function setEditorScrollTopIntentionally(
  scrollEditor: ScrollableEditor,
  scrollTop: number
): void {
  intentionalScrollEditors.add(scrollEditor)
  // Clear once the stack unwinds: Monaco may defer its scroll event until an outer event batch ends.
  queueMicrotask(() => intentionalScrollEditors.delete(scrollEditor))
  scrollEditor.setScrollTop(scrollTop)
}

export function isIntentionalEditorScroll(scrollEditor: ScrollableEditor): boolean {
  return intentionalScrollEditors.has(scrollEditor)
}
