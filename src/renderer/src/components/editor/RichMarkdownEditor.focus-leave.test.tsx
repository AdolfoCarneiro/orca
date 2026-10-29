// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { Editor } from '@tiptap/react'
import type * as EditorInstance from './useRichMarkdownEditorInstance'
import RichMarkdownEditor from './RichMarkdownEditor'

const live = vi.hoisted((): { editor: Editor | null } => ({ editor: null }))
vi.mock('./useRichMarkdownEditorInstance', async (importOriginal) => {
  const actual = await importOriginal<typeof EditorInstance>()
  return {
    useRichMarkdownEditorInstance: (
      ...args: Parameters<typeof actual.useRichMarkdownEditorInstance>
    ) => {
      const editor = actual.useRichMarkdownEditorInstance(...args)
      live.editor = editor
      return editor
    }
  }
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  live.editor = null
})

it.each(['outside', 'null', 'inside'] as const)(
  'flushes rich-root pending typing only when focus leaves (%s)',
  async (destination) => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    )
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ui: {
          setMarkdownEditorFocused: vi.fn(),
          onRichMarkdownContextCommand: () => () => {}
        }
      }
    })
    const onContentChange = vi.fn()
    const view = render(
      <RichMarkdownEditor
        fileId="focus-file"
        viewStateId="focus-view"
        content="base"
        filePath="/repo/focus.md"
        worktreeId="focus-workspace"
        scrollCacheKey="focus-file"
        onContentChange={onContentChange}
        onDirtyStateHint={() => {}}
        onSave={() => {}}
        headerSlot={<input aria-label="inside" />}
      />
    )
    await act(async () => {})
    const editor = live.editor
    const root = view.container.querySelector('.rich-markdown-editor-shell')
    if (!editor || !root) {
      throw new Error('Editor did not mount')
    }
    vi.useFakeTimers()
    act(() => {
      editor.commands.insertContent('typed ')
    })
    expect(onContentChange).not.toHaveBeenCalled()
    const relatedTarget =
      destination === 'inside'
        ? view.getByLabelText('inside')
        : destination === 'outside'
          ? document.body
          : null
    fireEvent.focusOut(root, { relatedTarget })
    if (destination === 'inside') {
      expect(onContentChange).not.toHaveBeenCalled()
    } else {
      expect(onContentChange).toHaveBeenCalledExactlyOnceWith('typed base')
    }
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(onContentChange).toHaveBeenCalledExactlyOnceWith('typed base')
  }
)

it.each(['Bold', 'Heading 2', 'More blocks', 'Link', 'Image', 'Remove link'] as const)(
  'uses the completed native range for the external %s action',
  async (action) => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    )
    const pickImage = vi.fn().mockResolvedValue(null)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ui: {
          setMarkdownEditorFocused: vi.fn(),
          onRichMarkdownContextCommand: () => () => {}
        },
        shell: { pickImage }
      }
    })
    const view = render(
      <RichMarkdownEditor
        fileId="selection-file"
        viewStateId="selection-view"
        content={
          action === 'Remove link'
            ? '[untouched](https://one.test)\n\n[lower caret](https://two.test)'
            : 'untouched\n\nlower caret'
        }
        filePath="/repo/selection.md"
        worktreeId="selection-workspace"
        scrollCacheKey="selection-file"
        onContentChange={() => {}}
        onDirtyStateHint={() => {}}
        onSave={() => {}}
      />
    )
    await act(async () => {})
    const editor = live.editor
    const paragraph = view.container.querySelector('.rich-markdown-editor p:last-child')
    const text = paragraph?.querySelector('a')?.firstChild ?? paragraph?.firstChild
    if (!editor || !paragraph || !text) {
      throw new Error('Expected mounted editor paragraph')
    }
    vi.useFakeTimers()
    act(() => {
      editor.view.focus()
      if (action === 'Remove link') {
        editor.commands.setTextSelection(2)
      }
    })
    const from = editor.view.posAtDOM(text, 6)
    const to = editor.view.posAtDOM(text, 11)
    vi.spyOn(editor.view, 'posAtCoords').mockReturnValue({ pos: from, inside: -1 })
    fireEvent.mouseDown(paragraph, { button: 0, buttons: 1, shiftKey: true })
    act(() => {
      document.getSelection()?.setBaseAndExtent(text, 11, text, 6)
      document.dispatchEvent(new Event('selectionchange'))
    })
    fireEvent.mouseUp(document, { button: 0 })
    expect(document.getSelection()?.toString()).toBe('caret')
    expect(editor.state.selection.from).not.toBe(from)

    const button = view.getByRole('button', { name: action, exact: true })
    expect(fireEvent.mouseDown(button, { button: 0 })).toBe(false)
    expect(document.activeElement).toBe(editor.view.dom)
    if (action === 'More blocks') {
      fireEvent.pointerDown(button, { button: 0, ctrlKey: false, pointerType: 'mouse' })
      fireEvent.click(view.getByRole('menuitem', { name: 'Heading 4' }))
    } else {
      fireEvent.click(button)
    }

    if (action === 'Bold') {
      expect(editor.view.dom.querySelector('strong')?.textContent).toBe('caret')
    } else if (action === 'Heading 2' || action === 'More blocks') {
      expect(editor.view.dom.querySelector(action === 'Heading 2' ? 'h2' : 'h4')?.textContent).toBe(
        'lower caret'
      )
      expect(editor.view.dom.querySelector('p')?.textContent).toBe('untouched')
    } else if (action === 'Link') {
      fireEvent.change(view.getByPlaceholderText('Paste or type a link…'), {
        target: { value: 'https://new.test' }
      })
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Enter' })
      expect(editor.view.dom.querySelector('a')?.textContent).toBe('caret')
    } else if (action === 'Remove link') {
      expect(editor.view.dom.querySelectorAll('a')).toHaveLength(1)
      expect(editor.view.dom.querySelector('a')?.textContent).toBe('untouched')
    } else {
      expect(pickImage).toHaveBeenCalledOnce()
      expect(editor.state.selection.anchor).toBe(to)
      expect(editor.state.selection.head).toBe(from)
    }
  }
)
