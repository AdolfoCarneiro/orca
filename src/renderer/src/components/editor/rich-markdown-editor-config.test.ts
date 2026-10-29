// @vitest-environment happy-dom

import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { Editor, type JSONContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { handleRichMarkdownEditorClick } from './rich-markdown-editor-click-routing'
import type { DocLinkMenuState } from './rich-markdown-commands'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinkBubbleState } from './RichMarkdownLinkBubble'
import {
  createRichMarkdownEditorConfig,
  type EditorConfigParams
} from './rich-markdown-editor-config'
import type { SlashMenuState } from './rich-markdown-slash-commands'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { createRichMarkdownHtmlSuperscriptLinkContext } from './rich-markdown-html-superscript-link-context'

vi.mock('./rich-markdown-editor-click-routing', () => ({
  handleRichMarkdownEditorClick: vi.fn()
}))

function ref<T>(current: T): MutableRefObject<T> {
  return { current }
}

function stateSetter<T>(): Dispatch<SetStateAction<T>> {
  return vi.fn() as Dispatch<SetStateAction<T>>
}

function getSpellcheckAttribute(config: ReturnType<typeof createRichMarkdownEditorConfig>): string {
  const attributes = config.editorProps?.attributes
  return typeof attributes === 'function'
    ? attributes({} as never).spellcheck
    : (attributes?.spellcheck ?? '')
}

function createConfigParams(overrides: Partial<EditorConfigParams> = {}): EditorConfigParams {
  const codec = createRichMarkdownEditorCodec()
  return {
    codec,
    htmlSuperscriptLinkContext: createRichMarkdownHtmlSuperscriptLinkContext({
      sourceFilePath: '/repo/README.md',
      worktreeId: 'worktree-1',
      worktreeRoot: '/repo',
      sourceOwner: { kind: 'local' }
    }),
    content: '',
    filePath: '/repo/README.md',
    worktreeId: 'worktree-1',
    worktreeRoot: '/repo',
    runtimeEnvironmentId: null,
    isMac: false,
    richMarkdownSpellcheckEnabled: true,
    runtimeTarget: { kind: 'local' },
    activateMarkdownLink: vi.fn(),
    rootRef: ref<HTMLDivElement | null>(null),
    editorRef: ref<Editor | null>(null),
    lastCommittedMarkdownRef: ref(''),
    originalSourceRef: ref(''),
    baseCanonicalRef: ref(''),
    reconcileRoundTripRef: ref<(markdown: string) => string | null>(() => null),
    onContentChangeRef: ref(vi.fn()),
    onDirtyStateHintRef: ref(vi.fn()),
    onSaveRef: ref(vi.fn()),
    onOpenDocLinkRef: ref(undefined),
    isEditingLinkRef: ref(false),
    slashMenuRef: ref(null),
    filteredSlashCommandsRef: ref([]),
    selectedCommandIndexRef: ref(0),
    docLinkMenuRef: ref(null),
    filteredDocLinkRowsRef: ref([]),
    selectedDocLinkIndexRef: ref(0),
    handleLocalImagePickRef: ref(vi.fn()),
    handleEmojiPickRef: ref(vi.fn()),
    typedEmptyOrderedListMarkerRef: ref(false),
    cancelAutoFocusRef: ref(null),
    fileId: 'file-a',
    serializeTimerRef: ref(null),
    pendingEditEpochRef: ref(0),
    isInitializingRef: ref(false),
    isApplyingProgrammaticUpdateRef: ref(false),
    markdownCommentsRef: ref([]),
    markdownSourceLineOffsetRef: ref(0),
    flushPendingSerialization: vi.fn(),
    openSearchRef: ref(vi.fn()),
    openAnnotationPopoverRef: ref(vi.fn()),
    syncAnnotationTarget: vi.fn(),
    clearAnnotationTarget: vi.fn(),
    scrollRichMarkdownReviewNoteCardIntoView: vi.fn(),
    setIsEditingLink: stateSetter<boolean>(),
    setLinkBubble: stateSetter<LinkBubbleState | null>(),
    setSelectedCommandIndex: stateSetter<number>(),
    setSelectedDocLinkIndex: stateSetter<number>(),
    setSlashMenu: stateSetter<SlashMenuState | null>(),
    setDocLinkMenu: stateSetter<DocLinkMenuState | null>(),
    ...overrides
  }
}

describe('createRichMarkdownEditorConfig', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('disables browser spellcheck when the rich Markdown setting is off', () => {
    const config = createRichMarkdownEditorConfig(
      createConfigParams({ richMarkdownSpellcheckEnabled: false })
    )

    expect(getSpellcheckAttribute(config)).toBe('false')
  })

  it('keeps browser spellcheck enabled by default', () => {
    const config = createRichMarkdownEditorConfig(createConfigParams())

    expect(getSpellcheckAttribute(config)).toBe('true')
  })

  it('flushes pending serialization when the rich editor blurs', () => {
    const setMarkdownEditorFocused = vi.fn()
    vi.stubGlobal('window', {
      api: { ui: { setMarkdownEditorFocused } }
    })
    const flushPendingSerialization = vi.fn()
    const clearAnnotationTarget = vi.fn()
    const config = createRichMarkdownEditorConfig(
      createConfigParams({ clearAnnotationTarget, flushPendingSerialization })
    )

    config.onBlur?.({} as never)

    expect(setMarkdownEditorFocused).toHaveBeenCalledWith(false)
    expect(clearAnnotationTarget).toHaveBeenCalledOnce()
    expect(flushPendingSerialization).toHaveBeenCalledOnce()
  })
})

describe('rich Markdown DOM click routing', () => {
  let editor: Editor

  beforeEach(() => {
    vi.mocked(handleRichMarkdownEditorClick).mockReset().mockReturnValue(true)
    editor = new Editor({ extensions: [StarterKit], content: '<p>example</p>' })
    vi.spyOn(editor.view, 'posAtCoords').mockReturnValue({ pos: 2, inside: 0 })
  })
  afterEach(() => editor.destroy())

  function click(event: PointerEvent, isMac = true): boolean | void {
    const config = createRichMarkdownEditorConfig(createConfigParams({ isMac }))
    return config.editorProps?.handleDOMEvents?.click?.call(editor.view, editor.view, event)
  }

  it.each([true, false])('routes the primary Shift+platform modifier click (Mac: %s)', (isMac) => {
    const event = new PointerEvent('click', {
      metaKey: isMac,
      ctrlKey: !isMac,
      shiftKey: true,
      cancelable: true
    })
    expect(click(event, isMac)).toBe(true)
    expect(event.defaultPrevented).toBe(true)
    expect(handleRichMarkdownEditorClick).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ event, pos: 2, view: editor.view })
    )
  })

  it.each([
    { shiftKey: true },
    { metaKey: true },
    { ctrlKey: true, shiftKey: true },
    { metaKey: true, shiftKey: true, button: 1 },
    { metaKey: true, shiftKey: true, button: 2 }
  ])('leaves neighboring gestures alone: %j', (modifiers) => {
    const event = new PointerEvent('click', { ...modifiers, cancelable: true })
    expect(click(event)).toBe(false)
    expect(event.defaultPrevented).toBe(false)
    expect(handleRichMarkdownEditorClick).not.toHaveBeenCalled()
  })

  it('avoids opening twice if Shift is pressed between mouse down and mouse up', () => {
    const config = createRichMarkdownEditorConfig(createConfigParams({ isMac: true }))
    const event = new MouseEvent('mouseup', { metaKey: true, shiftKey: true })
    expect(config.editorProps?.handleClick?.call(editor.view, editor.view, 2, event)).toBe(false)
    expect(handleRichMarkdownEditorClick).not.toHaveBeenCalled()
  })

  it('leaves an already handled click alone', () => {
    const event = new PointerEvent('click', { metaKey: true, shiftKey: true, cancelable: true })
    event.preventDefault()
    expect(click(event)).toBe(false)
    expect(handleRichMarkdownEditorClick).not.toHaveBeenCalled()
  })

  it('keeps selection behavior when no link handles the click', () => {
    vi.mocked(handleRichMarkdownEditorClick).mockReturnValue(false)
    const event = new PointerEvent('click', { metaKey: true, shiftKey: true, cancelable: true })
    expect(click(event)).toBe(false)
    expect(event.defaultPrevented).toBe(false)
  })
})

describe('numbered-marker text input admission', () => {
  const editors: Editor[] = []

  afterEach(() => {
    editors.splice(0).forEach((editor) => editor.destroy())
    vi.restoreAllMocks()
  })

  function markerEditor(content: NonNullable<JSONContent['content']>, offset?: number) {
    const params = createConfigParams()
    const config = createRichMarkdownEditorConfig(params)
    const editor = new Editor({
      extensions: [StarterKit],
      content: { type: 'doc', content: [{ type: 'paragraph', content }] },
      editorProps: config.editorProps
    })
    params.editorRef.current = editor
    const block = editor.state.doc.firstChild
    if (!block) {
      throw new Error('Missing marker paragraph')
    }
    editor.commands.setTextSelection((offset ?? block.content.size) + 1)
    const textBetween = vi.spyOn(block, 'textBetween')
    const originalNodesBetween = block.content.nodesBetween
    let visits = 0
    vi.spyOn(block.content, 'nodesBetween').mockImplementation(
      (from, to, callback, nodeStart, parent) =>
        originalNodesBetween.call(
          block.content,
          from,
          to,
          (node, pos, owner, index) => {
            visits++
            return callback(node, pos, owner, index)
          },
          nodeStart,
          parent
        )
    )
    editors.push(editor)
    function input(text = ' ', from = editor.state.selection.from, to = editor.state.selection.to) {
      params.typedEmptyOrderedListMarkerRef.current = true
      const handler = editor.view.props.handleTextInput
      if (!handler) {
        throw new Error('Production text-input handler was not registered')
      }
      const document = editor.state.doc
      expect(handler.call(editor.view, editor.view, from, to, text, () => editor.state.tr)).toBe(
        false
      )
      expect(editor.state.doc).toBe(document)
      return params.typedEmptyOrderedListMarkerRef.current
    }
    return { editor, input, textBetween, visits: () => visits }
  }

  it.each([
    { characters: 10_000, children: 100 },
    { characters: 100_000, children: 100 },
    { characters: 10_000, children: 1_000 },
    { characters: 100_000, children: 1_000 }
  ])('rejects prose without extracting its prefix: %j', ({ characters, children }) => {
    const content = Array.from({ length: children }, (_, index) => ({
      type: 'text',
      text: 'a'.repeat(characters / children),
      marks: [{ type: index % 2 ? 'bold' : 'italic' }]
    }))
    const { editor, input, textBetween, visits } = markerEditor(content)
    expect(editor.state.doc.firstChild?.childCount).toBe(children)
    expect(editor.state.selection.$from.parentOffset).toBe(characters)
    expect(input()).toBe(false)
    expect({ extractions: textBetween.mock.calls.length, inlineVisits: visits() }).toEqual({
      extractions: 0,
      inlineVisits: 0
    })
  })

  it.each([
    ['1.', true],
    ['0123.', true],
    ['12345678901234567890.', true],
    ['12', false],
    ['12.x', false],
    ['12..', false],
    [' 12.', false],
    ['a12.', false],
    ['１２.', false],
    ['١٢.', false],
    ['1.\n', false]
  ])('preserves marker detection for %j', (text, expected) => {
    const { editor, input } = markerEditor([{ type: 'text', text }])
    expect(editor.state.doc.firstChild?.textContent).toBe(text)
    expect(input()).toBe(expected)
  })

  it('keeps digit-leading marked fragments on the exact prefix path', () => {
    const { input, textBetween, visits } = markerEditor([
      { type: 'text', text: '12', marks: [{ type: 'bold' }] },
      { type: 'text', text: '3', marks: [{ type: 'italic' }] },
      { type: 'text', text: '.' }
    ])
    expect(input()).toBe(true)
    expect({ extractions: textBetween.mock.calls.length, inlineVisits: visits() }).toEqual({
      extractions: 1,
      inlineVisits: 3
    })
  })

  it('uses only the actual prefix when the caret precedes trailing text', () => {
    const { input } = markerEditor([{ type: 'text', text: '23.suffix' }], 3)
    expect(input()).toBe(true)
  })

  it.each([
    [{ type: 'hardBreak' }, { type: 'text', text: '1.' }],
    [{ type: 'text', text: '1' }, { type: 'hardBreak' }, { type: 'text', text: '.' }]
  ])('retains the exact fallback for hard breaks: %j', (...content) => {
    const { input, textBetween } = markerEditor(content)
    expect(input()).toBe(false)
    expect(textBetween).toHaveBeenCalledOnce()
  })

  it('clears the old hint at an empty paragraph', () => {
    expect(markerEditor([]).input()).toBe(false)
  })

  it.each(['ordinary key', 'replacement', 'selected range'])(
    'preserves the %s skip gate',
    (kind) => {
      const { editor, input, textBetween } = markerEditor([{ type: 'text', text: '123.' }])
      if (kind === 'selected range') {
        editor.commands.setTextSelection({ from: 1, to: 3 })
      }
      expect(
        kind === 'ordinary key' ? input('x') : kind === 'replacement' ? input(' ', 1, 3) : input()
      ).toBe(false)
      expect(textBetween).not.toHaveBeenCalled()
    }
  )
})
