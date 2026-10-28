// @vitest-environment happy-dom
import { act, useLayoutEffect, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { AppState } from '@/store'
import type { DiffComment } from '../../../../shared/diff-comment-types'
import { createFakeDiffCommentEditor } from '../diff-comments/diff-comment-editor-test-fixture'
import { getLargeDiffRenderLimitFromCounts } from './large-diff-render-limit'
import DiffViewer from './DiffViewer'

const fixture = vi.hoisted(() => {
  const noop = () => {}
  const addDiffComment: AppState['addDiffComment'] = async () => null
  const nextEditors: { editor: unknown; dispose: () => void }[] = []
  return {
    nextEditors,
    state: {
      settings: { theme: 'light' },
      editorFontZoomLevel: 0,
      addDiffComment,
      deleteDiffComment: noop,
      updateDiffComment: noop,
      scrollToDiffCommentId: null,
      setScrollToDiffCommentId: noop,
      worktreesByRepo: {},
      keybindings: {},
      activeAgentGroupIdByWorktree: {},
      activeGroupIdByWorktree: {},
      clearDeliveredDiffComments: noop
    }
  }
})

vi.mock('@monaco-editor/react', () => ({
  DiffEditor: ({ onMount }: { onMount: (editor: unknown, monaco: unknown) => void }) => {
    const instance = useRef(fixture.nextEditors.shift())
    const mount = useRef(onMount)
    useLayoutEffect(() => {
      const editor = instance.current
      if (!editor) {
        throw new Error('Missing pending draft editor fixture')
      }
      mount.current(editor.editor, {})
      return () => editor.dispose()
    }, [])
    return null
  }
}))
vi.mock('monaco-editor', () => ({
  editor: {
    EditorOption: { lineHeight: 1 },
    MouseTargetType: { GUTTER_LINE_NUMBERS: 3 },
    getModel: () => null,
    getModels: () => []
  },
  Uri: { parse: (value: string) => value },
  Range: class {
    constructor(
      public startLineNumber: number,
      public startColumn: number,
      public endLineNumber: number,
      public endColumn: number
    ) {}
  }
}))
vi.mock('@/lib/monaco-setup', async () => ({ monaco: await import('monaco-editor') }))
vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (snapshot: typeof fixture.state) => unknown) => selector(fixture.state),
    { getState: () => fixture.state, subscribe: () => () => {} }
  )
}))
vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en', resolvedLanguage: 'en', on() {}, off() {} },
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('./useContextualCopySetup', () => ({
  useContextualCopySetup: () => ({ setupCopy: () => {}, toastNode: null })
}))
vi.mock('./NotesSendMenu', () => ({ NotesSendMenu: () => null }))

type RetiredDraft = {
  editor: WeakRef<object>
  editorDom: WeakRef<HTMLElement>
  card: WeakRef<Element>
  renderLimit: WeakRef<object>
}

async function closeDiffWithPendingDraft(owner: number): Promise<RetiredDraft> {
  const modified = createFakeDiffCommentEditor()
  const original = createFakeDiffCommentEditor()
  const subscription = () => ({ dispose() {} })
  for (const fake of [modified, original]) {
    Object.assign(fake.editor, {
      getRawOptions: () => ({}),
      updateOptions() {},
      onDidChangeConfiguration: subscription,
      onWillChangeModel: subscription,
      onDidChangeModel: subscription
    })
  }
  const editor = {
    getOriginalEditor: () => original.editor,
    getModifiedEditor: () => modified.editor,
    getContainerDomNode: () => modified.domNode,
    onDidDispose: subscription,
    getLineChanges: () => [],
    onDidUpdateDiff: subscription,
    saveViewState: () => null,
    focus() {}
  }
  fixture.nextEditors.push({
    editor,
    dispose() {
      modified.emitDispose()
      original.emitDispose()
    }
  })
  const renderLimit = getLargeDiffRenderLimitFromCounts({
    originalLineCount: 1,
    modifiedLineCount: 1,
    originalCharacterCount: 8,
    modifiedCharacterCount: 8
  })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () =>
      root.render(
        <DiffViewer
          modelKey={`pending-draft-${owner}`}
          originalContent="original"
          modifiedContent="modified"
          language="markdown"
          filePath="/folder/readme.md"
          relativePath="readme.md"
          worktreeId={`workspace-${owner}`}
          sideBySide
          largeDiffRenderLimit={renderLimit}
        />
      )
    )
    modified.emitMouseMove(1)
    const add = modified.domNode.querySelector('.orca-diff-comment-add-btn')
    if (!add) {
      throw new Error('Missing real diff note action')
    }
    await act(async () => {
      const pointer = {
        bubbles: true,
        button: 0,
        pointerId: 1,
        clientY: modified.clientYForLine(1),
        clientX: 10,
        pointerType: 'mouse'
      }
      add.dispatchEvent(new PointerEvent('pointerdown', pointer))
      document.dispatchEvent(new PointerEvent('pointerup', pointer))
    })
    const zone = Array.from(modified.zones.values())[0]
    if (!zone) {
      throw new Error('Missing real diff draft zone')
    }
    modified.domNode.appendChild(zone.domNode)
    const card = zone.domNode.querySelector('.orca-diff-comment-draft-card')
    const textarea = card?.querySelector('textarea')
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    if (!card || !textarea || !setValue) {
      throw new Error('Missing real diff draft field')
    }
    await act(async () => {
      setValue.call(textarea, `Small review note ${owner}`)
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      textarea.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true
        })
      )
    })
    return {
      editor: new WeakRef(modified.editor),
      editorDom: new WeakRef(modified.domNode),
      card: new WeakRef(card),
      renderLimit: new WeakRef(renderLimit)
    }
  } finally {
    await act(async () => root.unmount())
    container.remove()
    modified.domNode.remove()
    original.domNode.remove()
    fixture.nextEditors.length = 0
  }
}

async function openSuccessorDraft(): Promise<() => Promise<void>> {
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  await act(async () =>
    root.render(
      <>
        <textarea onChange={() => {}} />
        <button type="button" onClick={() => {}} />
      </>
    )
  )
  // Move React's input and development event bookkeeping off the retired editor.
  await act(async () => {
    container.querySelector('textarea')?.focus()
    container.querySelector('button')?.click()
  })
  return async () => {
    await act(async () => root.unmount())
    container.remove()
  }
}

async function collect(): Promise<void> {
  if (typeof globalThis.gc !== 'function') {
    throw new Error('Run with --expose-gc to measure retired diff editors')
  }
  for (let round = 0; round < 4; round++) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    globalThis.gc()
  }
}

it('releases closed diff editors while accepted draft saves remain pending', async () => {
  const save = Promise.withResolvers<DiffComment | null>()
  const inputs: Parameters<AppState['addDiffComment']>[0][] = []
  const previousAdd = fixture.state.addDiffComment
  fixture.state.addDiffComment = (input) => {
    inputs.push(input)
    return save.promise
  }
  const retired: RetiredDraft[] = []
  let closeSuccessor: (() => Promise<void>) | undefined
  try {
    const previousStackTraceLimit = Error.stackTraceLimit
    try {
      // Production React omits development owner stacks that capture render inputs.
      Error.stackTraceLimit = 0
      for (let owner = 0; owner < 4; owner++) {
        retired.push(await closeDiffWithPendingDraft(owner))
      }
    } finally {
      Error.stackTraceLimit = previousStackTraceLimit
    }
    closeSuccessor = await openSuccessorDraft()
    await collect()
    expect(inputs.length).toBe(4)
    expect(inputs.every((input) => input.lineNumber === 1 && input.source === 'diff')).toBe(true)
    expect(inputs.map((input) => input.body)).toEqual([
      'Small review note 0',
      'Small review note 1',
      'Small review note 2',
      'Small review note 3'
    ])
    expect(retired.filter((owner) => owner.editor.deref()).length).toBe(0)
    expect(retired.filter((owner) => owner.editorDom.deref()).length).toBe(0)
    expect(retired.filter((owner) => owner.card.deref()).length).toBe(0)
    expect(retired.filter((owner) => owner.renderLimit.deref()).length).toBe(0)
  } finally {
    save.resolve(null)
    await act(async () => {
      await save.promise
      await new Promise<void>((resolve) => setImmediate(resolve))
    })
    fixture.state.addDiffComment = previousAdd
    await closeSuccessor?.()
  }
})
