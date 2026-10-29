import { beforeEach, describe, expect, it, vi } from 'vitest'
import { rectHasVisibleAreaOnAnyDisplay } from './window-bounds-validation'

const { getAllDisplays } = vi.hoisted(() => ({
  getAllDisplays:
    vi.fn<() => { workArea: { x: number; y: number; width: number; height: number } }[]>()
}))

vi.mock('electron', () => ({ screen: { getAllDisplays } }))

beforeEach(() => {
  getAllDisplays.mockReset()
  getAllDisplays.mockReturnValue([{ workArea: { x: 0, y: 40, width: 1440, height: 960 } }])
})

describe('restored window reachability', () => {
  it('rejects a titlebar above the remaining monitor even when most of the window is visible', () => {
    expect(
      rectHasVisibleAreaOnAnyDisplay({ x: 100, y: -200, width: 1000, height: 800 }, 300, 200)
    ).toBe(false)
  })

  it('rejects a titlebar behind the display work-area inset', () => {
    expect(
      rectHasVisibleAreaOnAnyDisplay({ x: 100, y: 0, width: 1000, height: 800 }, 300, 200)
    ).toBe(false)
  })

  it.each([40, 100, 500])('keeps a reachable titlebar at y=%i, including a tall window', (y) => {
    expect(rectHasVisibleAreaOnAnyDisplay({ x: 100, y, width: 1000, height: 800 }, 300, 200)).toBe(
      true
    )
  })

  it('keeps windows on a connected monitor above and left of the primary display', () => {
    getAllDisplays.mockReturnValue([
      { workArea: { x: -1600, y: -1200, width: 1600, height: 1200 } },
      { workArea: { x: 0, y: 40, width: 1440, height: 960 } }
    ])
    expect(
      rectHasVisibleAreaOnAnyDisplay({ x: -1500, y: -1100, width: 1000, height: 800 }, 300, 200)
    ).toBe(true)
  })

  it.each([
    { x: 1400, y: 100, width: 1000, height: 800 },
    { x: 100, y: 950, width: 1000, height: 800 }
  ])('still rejects a narrow visible sliver: %j', (rect) => {
    expect(rectHasVisibleAreaOnAnyDisplay(rect, 300, 200)).toBe(false)
  })
})
