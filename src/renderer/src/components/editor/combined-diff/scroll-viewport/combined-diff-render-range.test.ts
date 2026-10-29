import { describe, expect, it } from 'vitest'
import { getCombinedDiffRenderRange } from './combined-diff-render-range'

describe('combined diff render range', () => {
  it('does not prepare neighbors while the viewport is hidden', () => {
    expect(
      getCombinedDiffRenderRange(
        { startIndex: 2, endIndex: 3, count: 8, overscan: 5 },
        () => 230_000,
        0
      )
    ).toEqual([2, 3])
  })

  it('prepares one tall neighbor on each side without mounting all five', () => {
    expect(
      getCombinedDiffRenderRange(
        { startIndex: 2, endIndex: 3, count: 8, overscan: 5 },
        () => 230_000,
        800
      )
    ).toEqual([1, 2, 3, 4])
  })

  it('stops at a large neighboring section instead of skipping across it', () => {
    const heights = [100, 230_000, 100, 100, 230_000, 100]
    expect(
      getCombinedDiffRenderRange(
        { startIndex: 2, endIndex: 2, count: heights.length, overscan: 5 },
        (index) => heights[index],
        800
      )
    ).toEqual([1, 2, 3])
  })
})
