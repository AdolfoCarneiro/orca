// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useBrowserDevToolsDockBounds } from './use-browser-devtools-dock-bounds'

const overlay = vi.hoisted(() => ({ covered: false }))
vi.mock('@/lib/visible-overlay', () => ({ hasVisibleOverlayOver: () => overlay.covered }))
vi.mock('../host-guest/webview-drag-passthrough', () => ({
  isWebviewDragPassthroughActive: () => false
}))

const FIRST_FRAME = 'data:image/jpeg;base64,Zmlyc3Q='
const CURRENT_FRAME = 'data:image/jpeg;base64,Y3VycmVudA=='
const setDevToolsDockBounds = vi.fn<typeof window.api.browser.setDevToolsDockBounds>()
let captures: ReturnType<typeof Promise.withResolvers<string | null>>[]
let frame: FrameRequestCallback | null

function placeholder(width = 800, height = 600): HTMLDivElement {
  const element = document.createElement('div')
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 20, width, height))
  vi.spyOn(element, 'checkVisibility').mockReturnValue(true)
  return element
}

function sync(covered: boolean): void {
  act(() => {
    overlay.covered = covered
    const callback = frame
    frame = null
    callback?.(0)
  })
}

beforeEach(() => {
  captures = []
  frame = null
  overlay.covered = false
  setDevToolsDockBounds.mockReset().mockImplementation(({ snapshot }) => {
    if (!snapshot) {
      return Promise.resolve(null)
    }
    const capture = Promise.withResolvers<string | null>()
    captures.push(capture)
    return capture.promise
  })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frame = callback
    return 1
  })
  vi.stubGlobal('cancelAnimationFrame', () => {
    frame = null
  })
  vi.stubGlobal('window', { devicePixelRatio: 1, api: { browser: { setDevToolsDockBounds } } })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('useBrowserDevToolsDockBounds', () => {
  it('accepts the current covered frame and clears it when shown', async () => {
    const element = placeholder()
    const { result } = renderHook(() => useBrowserDevToolsDockBounds('page-1', element))
    sync(true)
    await act(async () => captures[0].resolve(CURRENT_FRAME))

    expect(result.current).toEqual({ url: CURRENT_FRAME, width: 800, height: 600 })
    sync(false)
    expect(result.current).toBeNull()
  })

  it('rejects an admitted result delivered during a later covered interval', async () => {
    const element = placeholder()
    const { result } = renderHook(() => useBrowserDevToolsDockBounds('page-1', element))
    sync(true)
    sync(false)
    vi.mocked(element.getBoundingClientRect).mockReturnValue(new DOMRect(10, 20, 640, 480))
    sync(true)

    // Main may have returned the first URL before these newer bounds reached it.
    await act(async () => captures[0].resolve(FIRST_FRAME))
    expect(result.current).toBeNull()
    await act(async () => captures[1].resolve(CURRENT_FRAME))
    expect(result.current).toEqual({ url: CURRENT_FRAME, width: 640, height: 480 })
  })

  it('rejects an admitted result from an effect that was cleaned up', async () => {
    overlay.covered = true
    const { result, rerender } = renderHook(
      ({ element }) => useBrowserDevToolsDockBounds('page-1', element),
      { initialProps: { element: placeholder() } }
    )
    rerender({ element: placeholder(400, 300) })

    await act(async () => captures[0].resolve(FIRST_FRAME))
    expect(result.current).toBeNull()
    await act(async () => captures[1].resolve(CURRENT_FRAME))
    expect(result.current).toEqual({ url: CURRENT_FRAME, width: 400, height: 300 })
  })
})
