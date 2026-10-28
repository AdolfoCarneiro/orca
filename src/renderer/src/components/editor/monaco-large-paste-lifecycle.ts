import type { MonacoLargeTextPasteResult, MonacoPasteEditor } from './monaco-large-text-paste'

type PasteResult = Exclude<MonacoLargeTextPasteResult, { status: 'ignored' | 'handled' }>
type PasteLifecycle = () => (result: PasteResult) => void

const pasteLifecycles = new WeakMap<MonacoPasteEditor, PasteLifecycle>()

export function registerMonacoLargePasteLifecycle(
  editor: MonacoPasteEditor,
  lifecycle: PasteLifecycle
): () => void {
  pasteLifecycles.set(editor, lifecycle)
  return () => {
    if (pasteLifecycles.get(editor) === lifecycle) {
      pasteLifecycles.delete(editor)
    }
  }
}

export function beginMonacoLargePasteLifecycle(
  editor: MonacoPasteEditor
): ((result: PasteResult) => void) | undefined {
  return pasteLifecycles.get(editor)?.()
}
