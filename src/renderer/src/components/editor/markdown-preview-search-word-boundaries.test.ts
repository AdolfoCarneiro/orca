import { describe, expect, it } from 'vitest'
import { findTextMatchRanges } from './markdown-preview-search'

describe('whole-word search around combining marks', () => {
  it.each(['\u0301', '\u093f', '\u{1d165}'])(
    'keeps the combining mark %s attached to its word',
    (mark) => {
      const text = `cat${mark} cat ${mark}cat`
      expect(findTextMatchRanges(text, 'cat', { wholeWord: true })).toEqual([
        { start: 4 + mark.length, end: 7 + mark.length }
      ])
      expect(findTextMatchRanges(text, 'cat', { wholeWord: true, matchCase: true })).toEqual([
        { start: 4 + mark.length, end: 7 + mark.length }
      ])
    }
  )

  it('finds a complete decomposed accented word and preserves source code-unit offsets', () => {
    const text = 'cafe\u0301 cafe cafe\u0301ine'
    expect(findTextMatchRanges(text, 'cafe\u0301', { wholeWord: true })).toEqual([
      { start: 0, end: 5 }
    ])
    expect(findTextMatchRanges(text, 'cafe', { wholeWord: true })).toEqual([{ start: 6, end: 10 }])
    expect(findTextMatchRanges(text, 'cafe')).toHaveLength(3)
  })
})
