import { expect, it, vi } from 'vitest'
import { flattenExtensions, getExtensionField } from '@tiptap/core'
import { RichMarkdownInlineMath, RichMarkdownStarterKit } from './rich-markdown-inline-tokenizers'
import { createTiptapMarkedFacade } from './tiptap-marked-facade'
import {
  createMarkdownTokenizerStart,
  registerMarkdownTokenizerStart
} from './markdown-tokenizer-start'

it.each([
  'x\n:::detailsSummary',
  'x\r:::detailsSummary',
  'x\u2028:::detailsSummary',
  'x\u2029:::detailsSummary',
  'x:::detailsSummary\n:::detailsSummary',
  'ordinary text'
])('matches the upstream multiline directive start: %j', (source) => {
  expect(createMarkdownTokenizerStart(':::detailsSummary', true)(source)).toBe(
    source.match(/^:::detailsSummary/m)?.index ?? -1
  )
})

it('does not search each remaining suffix for an absent marker', () => {
  const marked = createTiptapMarkedFacade()
  const start = createMarkdownTokenizerStart('MARKER')
  marked.use({
    extensions: [{ name: 'marker', level: 'block', start, tokenizer: () => undefined }]
  })
  const includes = vi.spyOn(String.prototype, 'includes')
  const indexOf = vi.spyOn(String.prototype, 'indexOf')
  try {
    marked.lexer('Prose\n\n'.repeat(1000))
    expect(includes.mock.calls.filter(([value]) => value === 'MARKER')).toHaveLength(1)
    expect(indexOf.mock.calls.filter(([value]) => value === 'MARKER')).toHaveLength(0)
  } finally {
    includes.mockRestore()
    indexOf.mockRestore()
  }
})

it('restores searches for nested generated input and later parses', () => {
  const marked = createTiptapMarkedFacade()
  const start = createMarkdownTokenizerStart('MARKER')
  marked.use({
    extensions: [
      {
        name: 'marker',
        level: 'block',
        start,
        tokenizer(source) {
          return source.startsWith('MARKER')
            ? { type: 'marker', raw: 'MARKER', text: 'found' }
            : undefined
        }
      },
      {
        name: 'wrapper',
        level: 'block',
        tokenizer(source) {
          if (!source.startsWith('WRAPPER')) {
            return undefined
          }
          return {
            type: 'wrapper',
            raw: 'WRAPPER',
            tokens: this.lexer.blockTokens('prose\nMARKER')
          }
        }
      }
    ]
  })
  const nested = marked.lexer('WRAPPER')
  expect(nested[0]).toMatchObject({
    type: 'wrapper',
    tokens: [{ type: 'paragraph' }, { type: 'marker' }]
  })
  expect(marked.lexer('prose\nMARKER').map((token) => token.type)).toEqual(['paragraph', 'marker'])
  expect(createTiptapMarkedFacade().lexer('MARKER')[0].type).toBe('paragraph')
})

it('skips custom searches when their required marker is absent', () => {
  const marked = createTiptapMarkedFacade()
  const search = vi.fn((source: string) => source.search(/<details\b/i))
  marked.use({
    extensions: [
      {
        name: 'details',
        level: 'block',
        start: registerMarkdownTokenizerStart('<', search),
        tokenizer: () => undefined
      }
    ]
  })
  marked.lexer('Prose\n\n'.repeat(1000))
  expect(search).not.toHaveBeenCalled()
  marked.lexer('Prose\n<DETAILS>')
  expect(search).toHaveReturnedWith(5)
})

it.each(['before', 'after'])(
  'reuses a marker search across paragraphs %s its only token',
  (placement) => {
    const marked = createTiptapMarkedFacade()
    marked.use({
      extensions: [
        {
          name: 'marker',
          level: 'block',
          start: createMarkdownTokenizerStart('MARKER'),
          tokenizer: (source) =>
            source.startsWith('MARKER')
              ? { type: 'marker', raw: 'MARKER', text: 'found' }
              : undefined
        }
      ]
    })
    const prose = 'Prose\n\n'.repeat(1000)
    const source = placement === 'before' ? `${prose}MARKER` : `MARKER\n\n${prose}`
    const indexOf = vi.spyOn(String.prototype, 'indexOf')
    try {
      const tokens = marked.lexer(source)
      expect(tokens.filter((token) => token.type === 'paragraph')).toHaveLength(1000)
      expect(tokens.filter((token) => token.type === 'marker')).toHaveLength(1)
      expect(indexOf.mock.calls.filter(([value]) => value === 'MARKER')).toHaveLength(1)
    } finally {
      indexOf.mockRestore()
    }
  }
)

it('recognizes a suffix-start directive skipped by an earlier line-start search', () => {
  const marked = createTiptapMarkedFacade()
  marked.use({
    extensions: [
      {
        name: 'directive',
        level: 'block',
        start: createMarkdownTokenizerStart(':::x', true),
        tokenizer: (source) =>
          source.startsWith(':::x') ? { type: 'directive', raw: ':::x', text: 'found' } : undefined
      }
    ]
  })
  expect(marked.lexer('Prose\n\nx:::x\n\n:::x').map(({ type, raw }) => ({ type, raw }))).toEqual([
    { type: 'paragraph', raw: 'Prose' },
    { type: 'space', raw: '\n\n' },
    { type: 'paragraph', raw: 'x' },
    { type: 'directive', raw: ':::x' },
    { type: 'space', raw: '\n\n' },
    { type: 'directive', raw: ':::x' }
  ])
})

function createInlineTokenizerFacade() {
  const marked = createTiptapMarkedFacade()
  for (const extension of flattenExtensions([RichMarkdownStarterKit, RichMarkdownInlineMath])) {
    if (extension.name !== 'underline' && extension.name !== 'inlineMath') {
      continue
    }
    const tokenizer = getExtensionField(extension, 'markdownTokenizer')
    if (
      !tokenizer ||
      typeof tokenizer === 'function' ||
      tokenizer.level !== 'inline' ||
      typeof tokenizer.start !== 'function'
    ) {
      throw new Error('Inline tokenizer configuration must be available')
    }
    marked.use({
      extensions: [
        {
          name: tokenizer.name,
          level: tokenizer.level,
          start: tokenizer.start,
          tokenizer(source, tokens) {
            return tokenizer.tokenize(source, tokens, {
              inlineTokens: (text) => this.lexer.inlineTokens(text),
              blockTokens: (text) => this.lexer.blockTokens(text)
            })
          }
        }
      ]
    })
  }
  return marked
}

it.each(['absent', 'before', 'after'])(
  'reuses inline marker searches with their only tokens %s escaped prose',
  (placement) => {
    const marked = createInlineTokenizerFacade()
    const prose = 'Prose \\! '.repeat(1000)
    const inline = '$x$ ++u++ '
    const source =
      placement === 'before' ? inline + prose : placement === 'after' ? prose + inline : prose
    const indexOf = vi.spyOn(String.prototype, 'indexOf')
    try {
      const tokens = marked.lexer(source)
      const inlineTokens = tokens.flatMap((token) =>
        'tokens' in token ? (token.tokens ?? []) : []
      )
      expect(tokens.filter((token) => token.type === 'paragraph')).toHaveLength(1)
      expect(inlineTokens.filter((token) => token.type === 'escape')).toHaveLength(1000)
      expect(inlineTokens.filter((token) => token.type === 'inlineMath')).toHaveLength(
        placement === 'absent' ? 0 : 1
      )
      expect(inlineTokens.filter((token) => token.type === 'underline')).toHaveLength(
        placement === 'absent' ? 0 : 1
      )
      for (const marker of ['$', '++']) {
        expect(
          indexOf.mock.calls.filter(([search]) => search === marker).length
        ).toBeLessThanOrEqual(3)
      }
    } finally {
      indexOf.mockRestore()
    }
  }
)

it('keeps inline cursors separate for recursive generated input and later parses', () => {
  const marked = createInlineTokenizerFacade()
  marked.use({
    extensions: [
      {
        name: 'generated',
        level: 'inline',
        start: (source) => source.indexOf('GEN'),
        tokenizer(source) {
          if (source.startsWith('GEN')) {
            return {
              type: 'generated',
              raw: 'GEN',
              tokens: this.lexer.inlineTokens('Generated longer prose $nested$ ++underlined++')
            }
          }
          return undefined
        }
      }
    ]
  })
  expect([...marked.lexer('Lead GEN end')]).toMatchObject([
    {
      type: 'paragraph',
      tokens: [
        { type: 'text', text: 'Lead ' },
        {
          type: 'generated',
          tokens: [
            { type: 'text', text: 'Generated longer prose ' },
            { type: 'inlineMath', latex: 'nested' },
            { type: 'text', text: ' ' },
            { type: 'underline', text: 'underlined' }
          ]
        },
        { type: 'text', text: ' end' }
      ]
    }
  ])
  expect([...marked.lexer('$later$ ++later++')]).toMatchObject([
    {
      type: 'paragraph',
      tokens: [
        { type: 'inlineMath', latex: 'later' },
        { type: 'text', text: ' ' },
        { type: 'underline', text: 'later' }
      ]
    }
  ])
})
