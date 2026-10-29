import { expect, it, vi } from 'vitest'
import { createTiptapMarkedFacade } from './tiptap-marked-facade'

it('bounds string reconstruction for repeated escaped punctuation', () => {
  const marked = createTiptapMarkedFacade()
  const source = 'Prose \\! '.repeat(2000)
  const originalSlice = String.prototype.slice
  let sliceUnits = 0
  const slice = vi.spyOn(String.prototype, 'slice').mockImplementation(function (
    this: string,
    start,
    end
  ) {
    const result = originalSlice.call(this, start, end)
    if (this.length === source.length) {
      sliceUnits += result.length
    }
    return result
  })
  try {
    expect(marked.parseInline(source)).toBe('Prose ! '.repeat(2000))
    expect(sliceUnits).toBeLessThanOrEqual(source.length * 5)
  } finally {
    slice.mockRestore()
  }
})

it('preserves the masking cursor after escaped astral punctuation', () => {
  const marked = createTiptapMarkedFacade()
  const masks: string[] = []
  marked.use({
    hooks: {
      emStrongMask(input) {
        masks.push(input)
        return input
      }
    }
  })
  marked.parseInline(`${'p'.repeat(17000)}\\!\\💥\\! `)
  expect(masks).toEqual([`${'p'.repeat(17000)}++++\\! `])
})

it('preserves dynamic punctuation rule getters and masked prefix context', () => {
  const marked = createTiptapMarkedFacade()
  const masks: string[] = []
  marked.use({
    hooks: {
      emStrongMask(input) {
        masks.push(input)
        return input
      }
    }
  })
  const lexer = new marked.Lexer(marked.defaults)
  const tokenizer = lexer.options.tokenizer
  if (!tokenizer) {
    throw new Error('Missing tokenizer')
  }
  const rules = tokenizer.rules
  const stock = rules.inline.anyPunctuation
  const lastIndex = stock.lastIndex
  const custom = /(?<=\+\+ )\\\?/g
  let reads = 0
  tokenizer.rules = {
    ...rules,
    inline: Object.defineProperty({ ...rules.inline }, 'anyPunctuation', {
      get() {
        reads++
        if (reads <= 2) {
          return stock
        }
        if (reads === 3) {
          custom.lastIndex = stock.lastIndex
        }
        return custom
      }
    })
  }
  try {
    stock.lastIndex = 0
    lexer.inlineTokens(`${'p'.repeat(17000)}\\! \\?`)
    expect(masks).toEqual([`${'p'.repeat(17000)}++ ++`])
    expect(reads).toBe(5)
  } finally {
    stock.lastIndex = lastIndex
  }
})

it('preserves proxy-backed rules without probing property descriptors', () => {
  const marked = createTiptapMarkedFacade()
  const masks: string[] = []
  marked.use({
    hooks: {
      emStrongMask(input) {
        masks.push(input)
        return input
      }
    }
  })
  const lexer = new marked.Lexer(marked.defaults)
  const tokenizer = lexer.options.tokenizer
  if (!tokenizer) {
    throw new Error('Missing tokenizer')
  }
  tokenizer.rules = new Proxy(tokenizer.rules, {
    getOwnPropertyDescriptor() {
      throw new Error('Unexpected custom descriptor probe')
    }
  })
  lexer.inlineTokens(`${'p'.repeat(17000)}\\! \\?`)
  expect(masks).toEqual([`${'p'.repeat(17000)}++ ++`])
})
