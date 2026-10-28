import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { marked } from 'marked'
import { normalizeMarkdownReferenceLinks } from './markdown-reference-link-normalization'

// Use marked’s own fence ranges as an independent oracle for normalization boundaries.
function markedCodeRanges(markdown: string): [number, number][] {
  const ranges: [number, number][] = []
  let offset = 0
  for (const token of marked.lexer(markdown.replace(/\r\n|\r/g, '\n'))) {
    if (token.type === 'code') {
      ranges.push([offset, offset + token.raw.length])
    }
    offset += token.raw.length
  }
  return ranges
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('normalizeMarkdownReferenceLinks', () => {
  it('inlines shortcut and full reference links', () => {
    expect(
      normalizeMarkdownReferenceLinks(
        '[Docs]\n[Issue][ticket]\n\n[docs]: https://example.com/docs\n[ticket]: https://example.com/issue "Issue"'
      )
    ).toBe('[Docs](https://example.com/docs)\n[Issue](https://example.com/issue "Issue")\n\n')
  })

  it('supports CRLF reference definitions', () => {
    expect(
      normalizeMarkdownReferenceLinks('[Docs]\r\n\r\n[docs]: https://example.com/docs\r\n')
    ).toBe('[Docs](https://example.com/docs)\r\n\r\n')
  })

  it('ignores definitions inside fenced code blocks', () => {
    const markdown = ['```md', '[docs]: https://example.com/docs', '```', '', '[Docs]'].join('\n')

    expect(normalizeMarkdownReferenceLinks(markdown)).toBe(markdown)
  })

  it('never removes a definition marked keeps inside a fenced code block', () => {
    const definition = '[docs]: https://example.com/docs'
    const survivors: string[] = []
    for (const outer of ['```', '````', '~~~', '~~~~']) {
      // Fence-shaped lines that do and do not close `outer`.
      for (const inner of ['```', '````', '~~~', '````js', '``` ', '```` trailing', '~~~a`b']) {
        const markdown = `${outer}\ncode\n${inner}\n${definition}\n[Docs]\n${outer}\n`
        const offset = markdown.indexOf(definition)
        const insideCode = markedCodeRanges(markdown).some(
          ([start, end]) => offset >= start && offset < end
        )
        if (insideCode && !normalizeMarkdownReferenceLinks(markdown).includes(definition)) {
          survivors.push(markdown)
        }
      }
    }
    expect(survivors).toEqual([])
  })

  it('scans newline-heavy documents without splitting into line arrays', () => {
    const split = vi.spyOn(String.prototype, 'split')
    const body = Array.from({ length: 5000 }, (_, index) => `line ${index + 1}`).join('\n')
    const markdown = `${body}\n\n[Docs]\n\n[docs]: https://example.com/docs\n`

    const normalized = normalizeMarkdownReferenceLinks(markdown)

    expect(normalized).toContain('[Docs](https://example.com/docs)')
    expect(split).not.toHaveBeenCalled()
  })

  it('folds whitespace-heavy reference labels without full whitespace replacement', () => {
    const replace = vi.spyOn(String.prototype, 'replace')
    const nonBreakingSpace = String.fromCharCode(160)
    const labelParts = Array.from({ length: 300 }, (_, index) => `PastedLabel${index}`)
    const usageLabel = labelParts.join(' ')
    const definitionLabel = ` \t${labelParts.join(` \t  ${nonBreakingSpace}`)}${nonBreakingSpace} `
    const markdown = `[Docs][${usageLabel}]\n\n[${definitionLabel}]: https://example.com/docs\n`

    expect(normalizeMarkdownReferenceLinks(markdown)).toBe('[Docs](https://example.com/docs)\n\n')
    expect(
      replace.mock.calls.filter(
        ([pattern]) => pattern instanceof RegExp && pattern.source === '\\s+'
      )
    ).toHaveLength(0)
  })
})

it.each([
  { name: 'unfinished text', prefix: '['.repeat(100_000) },
  { name: 'escaped closing brackets', prefix: '[\\] '.repeat(100_000) },
  { name: 'unfinished label', prefix: `[text][${'['.repeat(100_000)}` }
])('normalizes $name without repeatedly scanning the remaining source', ({ prefix }) => {
  const source = `[valid]\n${prefix}\n\n[valid]: https://example.com\n`
  const normalized = runInNewContext(
    'normalize(source)',
    { normalize: normalizeMarkdownReferenceLinks, source },
    { timeout: 1500 }
  )
  expect(normalized).toBe(`[valid](https://example.com)\n${prefix}\n\n`)
})

it('reuses the escape status of a shared closing bracket', () => {
  const prefix = `${'['.repeat(100_000)}${'\\'.repeat(100_000)}](`
  const source = `[valid]\n${prefix}\n\n[valid]: https://example.com\n`
  const normalized = runInNewContext(
    'normalize(source)',
    { normalize: normalizeMarkdownReferenceLinks, source },
    { timeout: 1500 }
  )
  expect(normalized).toBe(`[valid](https://example.com)\n${prefix}\n\n`)
})

it('reuses a missing full-reference label shared by unfinished text', () => {
  const prefix = `${'['.repeat(100_000)}][${'missing'.repeat(100_000)}]`
  const source = `[valid]\n${prefix}\n\n[valid]: https://example.com\n`
  const normalized = runInNewContext(
    'normalize(source)',
    { normalize: normalizeMarkdownReferenceLinks, source },
    { timeout: 1500 }
  )
  expect(normalized).toBe(`[valid](https://example.com)\n${prefix}\n\n`)
})

it.each([
  { name: 'shortcut', suffix: ']' },
  { name: 'collapsed', suffix: '][]' }
])('rejects impossible nested $name labels without repeated normalization', ({ suffix }) => {
  const prefix = `${'['.repeat(100_000)}${suffix}`
  const source = `[valid]\n${prefix}\n\n[valid]: https://example.com\n`
  const normalized = runInNewContext(
    'normalize(source)',
    { normalize: normalizeMarkdownReferenceLinks, source },
    { timeout: 1500 }
  )
  expect(normalized).toBe(`[valid](https://example.com)\n${prefix}\n\n`)
})

it('preserves bracket-bearing definitions and Unicode folding after rejected outer labels', () => {
  const source =
    '[[[[Docs] [[[[A\uFEFFΣ][] [Label][[Docs] [Docs]\n\n[[docs]: nested\n[[[a σ]: deeper\n[docs]: plain\n'

  expect(normalizeMarkdownReferenceLinks(source)).toBe(
    '[[[[Docs](nested) [[[[A\uFEFFΣ](deeper) [Label](nested) [Docs](plain)\n\n'
  )
})

it('rejects oversized nested labels across many supported bracket counts', () => {
  const count = 400_000
  const prefix = `${'['.repeat(count)}${'X'.repeat(count)}]`
  const definitions = Array.from(
    { length: Math.floor(Math.sqrt(count)) },
    (_, index) => `[${'['.repeat(index)}missing]: url`
  ).join('\n')
  const source = `${prefix}\n\n${definitions}\n`
  const normalized = runInNewContext(
    'normalize(source)',
    { normalize: normalizeMarkdownReferenceLinks, source },
    { timeout: 1500 }
  )
  expect(normalized).toBe(`${prefix}\n\n`)
})

it('keeps large supported labels after collapsing long whitespace runs', () => {
  const label = `${'['.repeat(50_000)}D${'\uFEFF'.repeat(50_000)}OCS`
  const definition = `${'['.repeat(50_000)}d ocs`
  const source = `${'['.repeat(8)}[${label}][]\n\n[${definition}]: large\n`
  expect(normalizeMarkdownReferenceLinks(source)).toBe(`${'['.repeat(8)}[${label}](large)\n\n`)
})

it.each(['界', '𐐀'])(
  'rejects oversized nested Unicode labels containing %s without repeated normalization',
  (character) => {
    const count = 400_000
    const prefix = `${'['.repeat(count)}${character.repeat(count)}]`
    const definitions = Array.from(
      { length: Math.floor(Math.sqrt(count)) },
      (_, index) => `[${'['.repeat(index)}missing]: url`
    ).join('\n')
    const source = `${prefix}\n\n${definitions}\n`
    const normalized = runInNewContext(
      'normalize(source)',
      { normalize: normalizeMarkdownReferenceLinks, source },
      { timeout: 1500 }
    )
    expect(normalized).toBe(`${prefix}\n\n`)
  }
)

it.each([' ', '\uFEFF'])(
  'folds a shared nested reference whitespace tail once for %j',
  (whitespace) => {
    const count = 2_000_000
    const prefix = `${'['.repeat(count)}${whitespace.repeat(count)}]`
    const definitions = Array.from(
      { length: Math.floor(Math.sqrt(count)) },
      (_, index) => `[${'['.repeat(index)}missing]: url`
    ).join('\n')
    const source = `${prefix}\n\n${definitions}\n`
    const normalized = runInNewContext(
      'normalize(source)',
      { normalize: normalizeMarkdownReferenceLinks, source },
      { timeout: 1500 }
    )
    expect(normalized).toBe(`${prefix}\n\n`)
  }
)

it('keeps unrelated long definitions from admitting impossible nested labels', () => {
  const count = 400_000
  const prefix = `${'['.repeat(count)}${'界'.repeat(count)}]`
  const definitions = Array.from(
    { length: Math.floor(Math.sqrt(count)) },
    (_, index) => `[${'['.repeat(index)}missing]: url`
  )
  definitions.push(`[${'Q'.repeat(count * 2)}]: unrelated`)
  const source = `${prefix}\n\n${definitions.join('\n')}\n`
  const normalized = runInNewContext(
    'normalize(source)',
    { normalize: normalizeMarkdownReferenceLinks, source },
    { timeout: 1500 }
  )
  expect(normalized).toBe(`${prefix}\n\n`)
})

it('reuses exact normalized suffix matches across long missing reference labels', () => {
  const length = 10_000
  const counts = 400
  const groups = 100
  const prefix = `${'['.repeat(counts)}Z${'界'.repeat(length)}]\n`.repeat(groups)
  const definitions = Array.from(
    { length: counts },
    (_, index) => `[${'['.repeat(index)}Q${'界'.repeat(length)}]: url`
  ).join('\n')
  const source = `${prefix}\n${definitions}\n`
  const normalized = runInNewContext(
    'normalize(source)',
    { normalize: normalizeMarkdownReferenceLinks, source },
    { timeout: 1500 }
  )
  expect(normalized).toBe(`${prefix}\n`)
})

it.each([
  { prefix: 'İ\u0301\u200d', text: ' \u200dΣ ', label: '\u200dσ' },
  { prefix: 'A\u0301\u200d', text: 'İ\u0301Σ', label: 'i\u0307\u0301ς' },
  { prefix: 'İ', text: ' \t\uFEFF ', label: ' ' }
])('preserves casing and trimming after a nested $prefix prefix', ({ prefix, text, label }) => {
  const definitions = Array.from(
    { length: 4 },
    (_, count) => `[${'['.repeat(count)}${'X'.repeat(32)}]: missing`
  )
  definitions.push(`[${label}]: target`)
  const source = `[[[${prefix}[${text}]\n\n${definitions.join('\n')}\n`
  expect(normalizeMarkdownReferenceLinks(source)).toBe(`[[[${prefix}[${text}](target)\n\n`)
})
