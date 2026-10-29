// @vitest-environment happy-dom

import { Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Plugin } from '@tiptap/pm/state'
import { recordPrefixReads } from './rich-markdown-completion-prefix.test-fixture'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { handleRichMarkdownEditorClick } from './rich-markdown-editor-click-routing'
import { syncDocLinkMenu } from './rich-markdown-commands'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRichMarkdownEditorConfig } from './rich-markdown-editor-config'
import { slashCommands, syncSlashMenu } from './rich-markdown-slash-commands'
import { createConfigParams, ref } from './rich-markdown-editor-config.test-fixture'

vi.mock('./rich-markdown-editor-click-routing', () => ({
  handleRichMarkdownEditorClick: vi.fn()
}))

function getSpellcheckAttribute(config: ReturnType<typeof createRichMarkdownEditorConfig>): string {
  const attributes = config.editorProps?.attributes
  return typeof attributes === 'function'
    ? attributes({} as never).spellcheck
    : (attributes?.spellcheck ?? '')
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

describe('rich Markdown completion callbacks', () => {
  const editors: Editor[] = []

  afterEach(() => {
    editors.splice(0).forEach((editor) => editor.destroy())
    document.body.replaceChildren()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  function slashEditor(content: string, onSlashMenu?: () => void) {
    vi.useFakeTimers()
    vi.stubGlobal('api', undefined)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { ui: { setMarkdownEditorFocused: vi.fn() } }
    })
    const root = document.createElement('div')
    document.body.append(root)
    const params = createConfigParams({ content, rootRef: ref(root) })
    params.filteredSlashCommandsRef.current = slashCommands
    const menuEvents: string[] = []
    const documentQueries: (string | null)[] = []
    params.setDocLinkMenu = (next) => {
      menuEvents.push('document')
      params.docLinkMenuRef.current =
        typeof next === 'function' ? next(params.docLinkMenuRef.current) : next
      documentQueries.push(params.docLinkMenuRef.current?.query ?? null)
    }
    params.setSlashMenu = (next) => {
      menuEvents.push('slash')
      params.slashMenuRef.current =
        typeof next === 'function' ? next(params.slashMenuRef.current) : next
      onSlashMenu?.()
    }
    const editor = new Editor({
      ...createRichMarkdownEditorConfig(params),
      extensions: createRichMarkdownExtensions({ codec: params.codec })
    })
    params.editorRef.current = editor
    root.append(editor.view.dom)
    vi.spyOn(editor.view, 'coordsAtPos').mockReturnValue({ top: 0, bottom: 20, left: 0, right: 0 })
    editors.push(editor)
    return { editor, params, menuEvents, documentQueries }
  }

  describe('completion prefix reuse', () => {
    it.each([
      { children: 1, unitsPerChild: 10_000, owners: 1 },
      { children: 1, unitsPerChild: 100_000, owners: 1 },
      { children: 100, unitsPerChild: 100, owners: 1 },
      { children: 1_000, unitsPerChild: 10, owners: 1 },
      { children: 1_000, unitsPerChild: 10, owners: 8 }
    ])(
      'shares reads across $children inline children, $unitsPerChild units each, $owners owners',
      ({ children, unitsPerChild, owners }) => {
        const views = Array.from({ length: owners }, () => slashEditor(''))
        const original = 'x'.repeat(children * unitsPerChild)
        for (const { editor, menuEvents } of views) {
          const nodes = Array.from({ length: children }, (_, index) =>
            editor.schema.text(
              'x'.repeat(unitsPerChild),
              index % 2 ? [editor.schema.marks.bold.create()] : []
            )
          )
          const paragraph = editor.schema.nodes.paragraph.create(null, nodes)
          editor.view.dispatch(
            editor.state.tr.replaceWith(0, editor.state.doc.content.size, paragraph)
          )
          editor.commands.setTextSelection(original.length + 1)
          expect(editor.state.doc.firstChild?.childCount).toBe(children)
          menuEvents.length = 0
        }
        const [active] = views
        if (!active) {
          throw new Error('Missing active completion editor')
        }
        const reads = recordPrefixReads(() => {
          active.editor.view.dispatch(active.editor.state.tr.insertText('x'))
        })
        const size = original.length + 1
        expect(active.menuEvents).toEqual(['slash', 'document', 'slash', 'document'])
        expect(active.editor.state.doc.firstChild?.textContent).toBe(`${original}x`)
        expect(active.params.slashMenuRef.current).toBeNull()
        expect(active.params.docLinkMenuRef.current).toBeNull()
        for (const idle of views.slice(1)) {
          expect(idle.menuEvents).toEqual([])
          expect(idle.editor.state.doc.firstChild?.textContent).toBe(original)
        }
        expect(reads).toEqual([
          { from: 0, to: size, codeUnits: size, nodes: children },
          { from: 0, to: size, codeUnits: size, nodes: children }
        ])
      }
    )

    it.each(['slash', 'document'] as const)(
      'keeps %s queries, ranges and geometry fresh across edits and option updates',
      (kind) => {
        const prefix = kind === 'slash' ? '' : 'before ('
        const initial = kind === 'slash' ? '/h' : `${prefix}[[Gu`
        const { editor, params, menuEvents } = slashEditor(initial)
        editor.commands.setTextSelection(initial.length + 1)
        const root = params.rootRef.current
        if (!root) {
          throw new Error('Missing completion root')
        }
        vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(new DOMRect(5, 7, 300, 200))
        vi.mocked(editor.view.coordsAtPos).mockReturnValue({
          top: 11,
          bottom: 31,
          left: 17,
          right: 18
        })
        menuEvents.length = 0
        const reads = recordPrefixReads(() => editor.view.dispatch(editor.state.tr.insertText('e')))
        expect(menuEvents).toEqual(['slash', 'document', 'slash', 'document'])
        const menu = kind === 'slash' ? params.slashMenuRef : params.docLinkMenuRef
        expect(menu.current).toEqual({
          query: kind === 'slash' ? 'he' : 'Gue',
          from: prefix.length + 1,
          to: initial.length + 2,
          left: 12,
          top: 32
        })
        editor.setOptions(createRichMarkdownEditorConfig(params))
        expect(editor.state.doc.firstChild?.textContent).toBe(`${initial}e`)
        vi.mocked(editor.view.coordsAtPos).mockReturnValue({
          top: 31,
          bottom: 51,
          left: 27,
          right: 28
        })
        const nextReads = recordPrefixReads(() =>
          editor.view.dispatch(editor.state.tr.insertText('a'))
        )
        expect(menu.current).toEqual({
          query: kind === 'slash' ? 'hea' : 'Guea',
          from: prefix.length + 1,
          to: initial.length + 3,
          left: 22,
          top: 52
        })
        expect(reads).toHaveLength(2)
        expect(nextReads).toHaveLength(2)
      }
    )

    it('refreshes a prefix when a menu setter dispatches a reentrant edit', () => {
      let reenter: (() => void) | undefined
      const { editor, params, documentQueries } = slashEditor('[[Gu', () => reenter?.())
      editor.commands.setTextSelection(5)
      documentQueries.length = 0
      reenter = () => {
        reenter = undefined
        editor.view.dispatch(editor.state.tr.insertText('d'))
      }
      const reads = recordPrefixReads(() => editor.view.dispatch(editor.state.tr.insertText('i')))
      expect(editor.state.doc.firstChild?.textContent).toBe('[[Guid')
      expect(documentQueries).toEqual(['Guid', 'Guid', 'Guid', 'Guid'])
      expect(params.docLinkMenuRef.current).toMatchObject({ query: 'Guid', from: 1, to: 7 })
      expect(reads.map((read) => read.codeUnits)).toEqual([5, 6, 6, 6, 6])
    })

    it('keeps each menu root admission live during a setter', () => {
      let removeRoot: (() => void) | undefined
      const { editor, params, menuEvents } = slashEditor('[[Gu', () => removeRoot?.())
      editor.commands.setTextSelection(5)
      removeRoot = () => {
        params.rootRef.current = null
      }
      menuEvents.length = 0
      const reads = recordPrefixReads(() => editor.view.dispatch(editor.state.tr.insertText('i')))
      expect(menuEvents).toEqual(['slash', 'document', 'slash', 'document'])
      expect(params.slashMenuRef.current).toBeNull()
      expect(params.docLinkMenuRef.current).toBeNull()
      expect(reads).toEqual([{ from: 0, to: 5, codeUnits: 5, nodes: 1 }])
    })

    it.each(['missing-root', 'read-only', 'composing', 'selection'])(
      'leaves prefix extraction behind the %s admission gate',
      (gate) => {
        const { editor, params, menuEvents } = slashEditor('[[Guide')
        editor.commands.setTextSelection(editor.state.doc.child(0).content.size + 1)
        if (gate === 'missing-root') {
          params.rootRef.current = null
        } else if (gate === 'read-only') {
          editor.setEditable(false)
        } else if (gate === 'composing') {
          Object.defineProperty(editor.view, 'composing', { value: true, configurable: true })
        }
        menuEvents.length = 0
        const reads = recordPrefixReads(() => {
          if (gate === 'selection') {
            editor.commands.setTextSelection({ from: 1, to: 3 })
          } else {
            editor.view.dispatch(editor.state.tr.insertText('x'))
          }
        })
        expect(reads).toEqual([])
        expect(menuEvents).toEqual(
          gate === 'selection' ? ['slash', 'document'] : ['slash', 'document', 'slash', 'document']
        )
        expect(params.slashMenuRef.current).toBeNull()
        expect(params.docLinkMenuRef.current).toBeNull()
        if (gate !== 'selection') {
          expect(editor.state.doc.child(0).textContent).toBe('[[Guidex')
        }
      }
    )

    it('updates document completion on a selection-only transaction', () => {
      const { editor, params, menuEvents } = slashEditor('[[Guide')
      editor.commands.setTextSelection(8)
      menuEvents.length = 0
      const before = editor.state.doc
      const reads = recordPrefixReads(() => editor.commands.setTextSelection(7))
      expect(menuEvents).toEqual(['slash', 'document'])
      expect(editor.state.doc).toBe(before)
      expect(params.docLinkMenuRef.current).toMatchObject({ query: 'Guid', from: 1, to: 7 })
      expect(reads).toEqual([{ from: 0, to: 6, codeUnits: 6, nodes: 1 }])
    })

    it('shares an empty prefix when a content-only transaction leaves the caret in place', () => {
      const { editor, menuEvents } = slashEditor('word')
      editor.commands.setTextSelection(1)
      menuEvents.length = 0
      const reads = recordPrefixReads(() =>
        editor.view.dispatch(editor.state.tr.insertText('x', 5))
      )
      expect(menuEvents).toEqual(['slash', 'document'])
      expect(editor.state.selection.from).toBe(1)
      expect(editor.state.doc.firstChild?.textContent).toBe('wordx')
      expect(reads).toEqual([{ from: 0, to: 0, codeUnits: 0, nodes: 0 }])
    })

    it.each(['prevented-update', 'programmatic-update'] as const)(
      'preserves the %s callback and dirty-state policy',
      (mode) => {
        const { editor, params, menuEvents } = slashEditor('/h')
        editor.commands.setTextSelection(3)
        if (mode === 'programmatic-update') {
          params.isApplyingProgrammaticUpdateRef.current = true
        }
        vi.mocked(params.onDirtyStateHintRef.current).mockClear()
        menuEvents.length = 0
        const reads = recordPrefixReads(() => {
          const transaction = editor.state.tr.insertText('e')
          if (mode === 'prevented-update') {
            transaction.setMeta('preventUpdate', true)
          }
          editor.view.dispatch(transaction)
        })
        expect(menuEvents).toEqual(
          mode === 'prevented-update'
            ? ['slash', 'document']
            : ['slash', 'document', 'slash', 'document']
        )
        expect(params.slashMenuRef.current).toMatchObject({ query: 'he', from: 1, to: 4 })
        expect(params.onDirtyStateHintRef.current).not.toHaveBeenCalled()
        expect(params.serializeTimerRef.current).toBeNull()
        expect(reads).toHaveLength(mode === 'prevented-update' ? 1 : 2)
      }
    )

    it('keeps the existing three-argument menu synchronization route', () => {
      const { editor, params, menuEvents } = slashEditor('[[Guide')
      editor.commands.setTextSelection(8)
      menuEvents.length = 0
      const reads = recordPrefixReads(() => {
        syncSlashMenu(editor, params.rootRef.current, params.setSlashMenu)
        syncDocLinkMenu(editor, params.rootRef.current, params.setDocLinkMenu)
      })
      expect(menuEvents).toEqual(['slash', 'document'])
      expect(params.slashMenuRef.current).toBeNull()
      expect(params.docLinkMenuRef.current).toMatchObject({ query: 'Guide', from: 1, to: 8 })
      expect(reads).toEqual([
        { from: 0, to: 7, codeUnits: 7, nodes: 1 },
        { from: 0, to: 7, codeUnits: 7, nodes: 1 }
      ])
    })

    it('reads the final state after an appended transaction', () => {
      const { editor, params, menuEvents } = slashEditor('/')
      editor.commands.setTextSelection(2)
      editor.registerPlugin(
        new Plugin({
          appendTransaction(transactions, _previous, state) {
            const shouldAppend = transactions.some((transaction) =>
              transaction.getMeta('completion-prefix-append')
            )
            if (shouldAppend) {
              return state.tr.insertText('e')
            }
            return null
          }
        })
      )
      menuEvents.length = 0
      const reads = recordPrefixReads(() => {
        editor.view.dispatch(
          editor.state.tr.insertText('h').setMeta('completion-prefix-append', true)
        )
      })
      expect(menuEvents).toEqual(['slash', 'document', 'slash', 'document'])
      expect(editor.state.doc.firstChild?.textContent).toBe('/he')
      expect(params.slashMenuRef.current).toMatchObject({ query: 'he', from: 1, to: 4 })
      expect(reads).toEqual([
        { from: 0, to: 3, codeUnits: 3, nodes: 1 },
        { from: 0, to: 3, codeUnits: 3, nodes: 1 }
      ])
    })
  })
})
