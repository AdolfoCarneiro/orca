// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { afterEach, expect, it, vi } from 'vitest'
import { useRichMarkdownSearch } from './useRichMarkdownSearch'

vi.mock('@/store', () => ({
  useAppStore: (select: (state: unknown) => unknown) => select({ keybindings: {} })
}))

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it('replaces whole words without leaving an accent from a larger word, with undo and redo', () => {
  vi.useFakeTimers()
  const editor = new Editor({ extensions: [StarterKit], content: '<p>cafe\u0301 cafe</p>' })
  const hook = renderHook(() =>
    useRichMarkdownSearch({
      editor,
      rootRef: { current: null },
      scrollContainerRef: { current: null }
    })
  )
  try {
    act(() => hook.result.current.openSearch())
    act(() => {
      hook.result.current.searchActions.setSearchQuery('cafe')
      hook.result.current.searchActions.setReplaceQuery('tea')
      hook.result.current.searchActions.toggleWholeWord()
    })
    act(() => vi.advanceTimersByTime(150))
    expect(hook.result.current.searchState.matchCount).toBe(1)
    act(() => hook.result.current.searchActions.replaceAllMatches())
    expect(editor.getText()).toBe('cafe\u0301 tea')
    act(() => expect(editor.commands.undo()).toBe(true))
    expect(editor.getText()).toBe('cafe\u0301 cafe')
    act(() => expect(editor.commands.redo()).toBe(true))
    expect(editor.getText()).toBe('cafe\u0301 tea')
  } finally {
    hook.unmount()
    editor.destroy()
  }
})
