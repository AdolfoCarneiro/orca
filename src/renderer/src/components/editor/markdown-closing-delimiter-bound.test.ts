import { expect, it, vi } from 'vitest'
import { Lexer, type Token } from 'marked'
import { createTiptapMarkedFacade } from './tiptap-marked-facade'

it.each(['*', '_', '~'] as const)(
  'does not rescan every mask suffix after consuming the only closing %s delimiter',
  (marker) => {
    const marked = createTiptapMarkedFacade()
    marked.setOptions({ gfm: true })
    const body = `${marker}open `.repeat(1000)
    const source = `${marker}paired${marker} ${body}`
    const originalSlice = String.prototype.slice
    const originalLastIndexOf = String.prototype.lastIndexOf
    let maskSlices = 0
    let backwardSearchSpans = 0
    const slice = vi.spyOn(String.prototype, 'slice').mockImplementation(function (
      this: string,
      start,
      end
    ) {
      if (this.valueOf() === source && start !== undefined && start < 0 && end === undefined) {
        maskSlices++
      }
      return originalSlice.call(this, start, end)
    })
    const lastIndexOf = vi.spyOn(String.prototype, 'lastIndexOf').mockImplementation(function (
      this: string,
      search,
      from
    ) {
      const index = originalLastIndexOf.call(this, search, from)
      if (search === marker) {
        const start =
          from === undefined ? this.length - 1 : Math.min(this.length - 1, Math.max(0, from))
        backwardSearchSpans += index < 0 ? start + 1 : start - index + 1
      }
      return index
    })
    try {
      const tokens = marked.lexer(source)
      expect(tokens).toHaveLength(1)
      expect(tokens[0]).toMatchObject({
        type: 'paragraph',
        tokens: [
          { type: marker === '~' ? 'del' : 'em', text: 'paired' },
          { type: 'text', text: ` ${body}` }
        ]
      })
      expect(maskSlices).toBeLessThanOrEqual(3)
      expect(backwardSearchSpans).toBeLessThanOrEqual(source.length)
    } finally {
      slice.mockRestore()
      lastIndexOf.mockRestore()
    }
  }
)

it('preserves synthetic masks and recursive tokenization after an outer miss', () => {
  const marked = createTiptapMarkedFacade()
  marked.setOptions({ gfm: true })
  let generated: Token[] = []
  marked.use({
    extensions: [
      {
        name: 'generated',
        level: 'inline',
        start: (source) => source.indexOf('GEN'),
        tokenizer(source) {
          if (!source.startsWith('GEN')) {
            return undefined
          }
          const tokenizer = this.lexer.options.tokenizer
          if (!tokenizer) {
            throw new Error('Missing tokenizer')
          }
          expect(tokenizer.emStrong('*direct*', '*direct*')).toMatchObject({
            type: 'em',
            text: 'direct'
          })
          generated = this.lexer.inlineTokens('Longer *nested* _nested_ ~nested~ text')
          return { type: 'generated', raw: 'GEN', tokens: generated }
        }
      }
    ]
  })
  marked.lexer('Lead *open _open ~open GEN tail')
  expect(generated.map((token) => token.type)).toEqual([
    'text',
    'em',
    'text',
    'em',
    'text',
    'del',
    'text'
  ])
  expect(marked.lexer('*later*')[0]).toMatchObject({
    type: 'paragraph',
    tokens: [{ type: 'em', text: 'later' }]
  })
})

it('preserves in-place changes to stock delimiter rules', () => {
  const marked = createTiptapMarkedFacade()
  marked.setOptions({ gfm: true })
  const rule = Lexer.rules.inline.gfm.emStrongRDelimAst
  const { source, flags, lastIndex } = rule
  try {
    rule.compile(' (\\*+)', 'gu')
    expect(marked.lexer('*a *b ')[0]).toMatchObject({
      type: 'paragraph',
      tokens: [
        { type: 'em', raw: '*a *', text: 'a ' },
        { type: 'text', text: 'b ' }
      ]
    })
  } finally {
    rule.compile(source, flags)
    rule.lastIndex = lastIndex
  }
})
