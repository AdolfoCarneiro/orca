// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EDITOR_REVEAL_FLASH_MS,
  flashRevealedEditorView,
  useEditorRevealFlashKey
} from './editor-reveal-flash'

describe('editor reveal flash', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('flashes only the revealed view and clears after the animation', () => {
    vi.useFakeTimers()
    const target = renderHook(() => useEditorRevealFlashKey('view-a'))
    const other = renderHook(() => useEditorRevealFlashKey('view-b'))

    act(() => flashRevealedEditorView('view-a'))
    expect(target.result.current).not.toBeNull()
    expect(other.result.current).toBeNull()

    act(() => vi.advanceTimersByTime(EDITOR_REVEAL_FLASH_MS))
    expect(target.result.current).toBeNull()
  })

  it('restarts with a new key and a fresh timer on a repeat flash', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useEditorRevealFlashKey('view-c'))

    act(() => flashRevealedEditorView('view-c'))
    const firstKey = result.current
    act(() => vi.advanceTimersByTime(EDITOR_REVEAL_FLASH_MS - 100))
    act(() => flashRevealedEditorView('view-c'))
    expect(result.current).not.toBe(firstKey)

    act(() => vi.advanceTimersByTime(EDITOR_REVEAL_FLASH_MS - 100))
    expect(result.current).not.toBeNull()
    act(() => vi.advanceTimersByTime(100))
    expect(result.current).toBeNull()
  })
})
