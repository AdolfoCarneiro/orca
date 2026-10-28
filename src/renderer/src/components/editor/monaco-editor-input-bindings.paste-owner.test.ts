// @vitest-environment happy-dom
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import type { editor } from 'monaco-editor'
import { afterEach, expect, it, vi } from 'vitest'
import { installMonacoEditorInputBindings } from './monaco-editor-input-bindings'
import { isEditorLargePasteInFlight } from './editor-large-paste-in-flight'

vi.mock('@/store', () => ({ useAppStore: { getState: vi.fn() } }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('./editor-shortcuts', () => ({
  installEditorSaveShortcut: () => vi.fn(),
  installMonacoEditorFindShortcut: () => vi.fn(),
  installEditorAddReviewNoteShortcut: () => vi.fn()
}))

afterEach(() => {
  document.body.replaceChildren()
  for (const model of monaco.editor.getModels()) {
    model.dispose()
  }
})

it.each(['detached', 'reassigned', 'disposed'] as const)(
  'finalizes a cancelled paste against its original model and publisher after the editor is %s',
  async (transition) => {
    const originalModel = monaco.editor.createModel('original')
    const successorModel = monaco.editor.createModel('successor')
    let liveModel: editor.ITextModel | null = originalModel
    let focused = true
    let selection = originalModel.getFullModelRange().collapseToEnd()
    const node = document.createElement('div')
    document.body.append(node)
    const getValue = vi.fn(() => liveModel?.getValue() ?? '')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the input binding and paste executor use these real model, selection, action, and DOM methods.
    const instance = {
      getModel: () => liveModel,
      getValue,
      getContainerDomNode: () => node,
      hasTextFocus: () => focused,
      getSelection: () => selection,
      setSelection: (next: monaco.IRange) => {
        selection = monaco.Range.lift(next)
      },
      executeEdits: (_source: string, edits: editor.IIdentifiedSingleEditOperation[]) => {
        liveModel?.pushEditOperations([], edits, () => null)
        return true
      },
      pushUndoStop: () => {
        liveModel?.pushStackElement()
        return true
      },
      addAction: () => ({ dispose: vi.fn() })
    } as unknown as editor.IStandaloneCodeEditor
    const originalPublisher = vi.fn()
    const successorPublisher = vi.fn()
    const propsRef = {
      current: {
        relativePath: 'original.txt',
        language: 'plaintext',
        onSave: vi.fn(),
        onContentChange: originalPublisher
      }
    }
    const lastSyncedContentRef = { current: 'original' }
    const isApplyingLargePasteRef = { current: false }
    const binding = installMonacoEditorInputBindings({
      editorInstance: instance,
      worktreeId: undefined,
      editorContainerRef: { current: node },
      propsRef,
      readOnlyRef: { current: false },
      lastSyncedContentRef,
      isApplyingLargePasteRef,
      commentPopoverRef: { current: null },
      shouldShowMarkdownAnnotationsRef: { current: false },
      setCommentPopover: vi.fn(),
      setSelectionAnnotationTarget: vi.fn()
    })
    let changes = 0
    const subscription = originalModel.onDidChangeContent(() => {
      changes++
      if (changes !== 3) {
        return
      }
      focused = false
      liveModel = transition === 'reassigned' ? successorModel : null
      propsRef.current.onContentChange = successorPublisher
      if (transition === 'disposed') {
        originalModel.dispose()
      }
    })
    const data = new DataTransfer()
    data.setData('text/plain', 'paste row\n'.repeat(10_000))
    const event = new ClipboardEvent('paste', { clipboardData: data, cancelable: true })
    try {
      node.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(true)
      await vi.waitFor(() => {
        expect(isApplyingLargePasteRef.current).toBe(false)
        expect(isEditorLargePasteInFlight(originalModel.uri.toString())).toBe(false)
      })
      expect(changes).toBe(3)
      expect(getValue).not.toHaveBeenCalled()
      expect(successorPublisher).not.toHaveBeenCalled()
      expect(successorModel.getValue()).toBe('successor')
      expect(lastSyncedContentRef.current).toBe('original')
      if (transition === 'disposed') {
        expect(originalPublisher).not.toHaveBeenCalled()
      } else {
        expect(originalPublisher).toHaveBeenCalledExactlyOnceWith(originalModel.getValue())
        expect(originalModel.getValueLength()).toBeGreaterThan('original'.length)
        originalModel.undo()
        expect(originalModel.getValue()).toBe('original')
      }
    } finally {
      subscription.dispose()
      binding.disposeInputBindings()
    }
  }
)
