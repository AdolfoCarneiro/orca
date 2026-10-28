// @vitest-environment happy-dom
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import type { editor } from 'monaco-editor'
import { afterEach, expect, it, vi } from 'vitest'
import { installMonacoEditorInputBindings } from './monaco-editor-input-bindings'
import { isEditorLargePasteInFlight } from './editor-large-paste-in-flight'
import { executeMonacoLargeTextPaste } from './monaco-large-text-paste'

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

function mountSourceEditor() {
  const originalModel = monaco.editor.createModel('original')
  let liveModel: editor.ITextModel | null = originalModel
  let focused = true
  let selections = [
    monaco.Selection.fromRange(
      originalModel.getFullModelRange().collapseToEnd(),
      monaco.SelectionDirection.LTR
    )
  ]
  const node = document.createElement('div')
  document.body.append(node)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the input binding and paste executor use these real model, selection, action, and DOM methods.
  const instance = {
    getModel: () => liveModel,
    getValue: () => liveModel?.getValue() ?? '',
    getContainerDomNode: () => node,
    hasTextFocus: () => focused,
    getSelection: () => selections[0],
    getSelections: () => selections,
    setSelection: (next: monaco.IRange) => {
      selections = [
        monaco.Selection.fromRange(monaco.Range.lift(next), monaco.SelectionDirection.LTR)
      ]
    },
    executeEdits: (
      _source: string,
      edits: editor.IIdentifiedSingleEditOperation[],
      cursorState?: editor.ICursorStateComputer | monaco.Selection[]
    ) => {
      const next = liveModel?.pushEditOperations(selections, edits, (inverse) =>
        typeof cursorState === 'function' ? cursorState(inverse) : (cursorState ?? null)
      )
      if (next) {
        selections = next
      }
      return true
    },
    pushUndoStop: () => {
      liveModel?.pushStackElement()
      return true
    },
    addAction: () => ({ dispose: vi.fn() })
  } as unknown as editor.IStandaloneCodeEditor
  const originalPublisher = vi.fn()
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
  return {
    node,
    instance,
    originalModel,
    originalPublisher,
    propsRef,
    lastSyncedContentRef,
    isApplyingLargePasteRef,
    binding,
    loseTarget: (next: editor.ITextModel | null) => {
      focused = false
      liveModel = next
    }
  }
}

const largeText = 'paste row\n'.repeat(10_000)

it.each(['detached', 'reassigned', 'disposed'] as const)(
  'finalizes a cancelled paste against its original model and publisher after the editor is %s',
  async (transition) => {
    const {
      node,
      originalModel,
      originalPublisher,
      propsRef,
      lastSyncedContentRef,
      isApplyingLargePasteRef,
      binding,
      loseTarget
    } = mountSourceEditor()
    const successorModel = monaco.editor.createModel('successor')
    const successorPublisher = vi.fn()
    let changes = 0
    const subscription = originalModel.onDidChangeContent(() => {
      changes++
      if (changes !== 3) {
        return
      }
      loseTarget(transition === 'reassigned' ? successorModel : null)
      propsRef.current.onContentChange = successorPublisher
      if (transition === 'disposed') {
        originalModel.dispose()
      }
    })
    const data = new DataTransfer()
    data.setData('text/plain', largeText)
    const event = new ClipboardEvent('paste', { clipboardData: data, cancelable: true })
    try {
      node.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(true)
      await vi.waitFor(() => {
        expect(isApplyingLargePasteRef.current).toBe(false)
        expect(isEditorLargePasteInFlight(originalModel.uri.toString())).toBe(false)
      })
      expect(changes).toBe(3)
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

it('holds paste state for every chunk of a menu paste and publishes once', async () => {
  const {
    instance,
    originalModel,
    originalPublisher,
    lastSyncedContentRef,
    isApplyingLargePasteRef,
    binding
  } = mountSourceEditor()
  const uri = originalModel.uri.toString()
  const chunkStates: boolean[] = []
  const subscription = originalModel.onDidChangeContent(() => {
    chunkStates.push(isApplyingLargePasteRef.current && isEditorLargePasteInFlight(uri))
  })
  try {
    const result = await executeMonacoLargeTextPaste(instance, largeText, { readOnly: false })

    expect(result.status).toBe('pasted')
    expect(chunkStates.length).toBeGreaterThan(1)
    expect(chunkStates.every(Boolean)).toBe(true)
    expect(isApplyingLargePasteRef.current).toBe(false)
    expect(isEditorLargePasteInFlight(uri)).toBe(false)
    expect(originalPublisher).toHaveBeenCalledExactlyOnceWith(originalModel.getValue())
    expect(lastSyncedContentRef.current).toBe(originalModel.getValue())
    originalModel.undo()
    expect(originalModel.getValue()).toBe('original')
  } finally {
    subscription.dispose()
    binding.disposeInputBindings()
  }
})

it('stops wrapping menu pastes after the input bindings are disposed', async () => {
  const { instance, originalModel, originalPublisher, isApplyingLargePasteRef, binding } =
    mountSourceEditor()
  binding.disposeInputBindings()
  const appliedStates: boolean[] = []
  const subscription = originalModel.onDidChangeContent(() => {
    appliedStates.push(isApplyingLargePasteRef.current)
  })
  try {
    await executeMonacoLargeTextPaste(instance, largeText, { readOnly: false })

    expect(appliedStates.length).toBeGreaterThan(1)
    expect(appliedStates.some(Boolean)).toBe(false)
    expect(originalPublisher).not.toHaveBeenCalled()
  } finally {
    subscription.dispose()
  }
})
