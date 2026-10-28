import { expect, it, vi } from 'vitest'
import { createTiptapMarkedFacade } from './tiptap-marked-facade'

it.each(['*', '_', '~'] as const)('bounds rescans before a late %s closer', (marker) => {
  const marked = createTiptapMarkedFacade()
  marked.setOptions({ gfm: true })
  const body = `${marker}open `
  const source = `${body.repeat(1000)}close${marker}`
  const originalSlice = String.prototype.slice
  const originalIndexOf = String.prototype.indexOf
  let maskSlices = 0
  let forwardSpans = 0
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
  const indexOf = vi.spyOn(String.prototype, 'indexOf').mockImplementation(function (
    this: string,
    search,
    from
  ) {
    const index = originalIndexOf.call(this, search, from)
    if (this.valueOf() === source && search === marker) {
      const start = Math.min(this.length, Math.max(0, from ?? 0))
      forwardSpans += (index < 0 ? this.length : index + 1) - start
    }
    return index
  })
  try {
    expect(marked.lexer(source)[0]).toMatchObject({
      type: 'paragraph',
      tokens: [
        { type: 'text', text: body.repeat(999) },
        { type: marker === '~' ? 'del' : 'em', text: 'open close' }
      ]
    })
    expect(maskSlices).toBeLessThanOrEqual(3)
    expect(forwardSpans).toBeLessThanOrEqual(source.length)
  } finally {
    slice.mockRestore()
    indexOf.mockRestore()
  }
})

it('preserves strike matching across runs with different lengths', () => {
  const marked = createTiptapMarkedFacade()
  marked.setOptions({ gfm: true })
  expect(marked.lexer('b~~ ~a b** *a b_ b* ~~a b~ ')[0]).toMatchObject({
    type: 'paragraph',
    tokens: [
      { type: 'text', text: 'b~~ ' },
      {
        type: 'del',
        text: 'a b** *a b_ b* ~~a b',
        tokens: [
          { type: 'text', text: 'a b** ' },
          { type: 'em', text: 'a b_ b' },
          { type: 'text', text: ' ~~a b' }
        ]
      },
      { type: 'text', text: ' ' }
    ]
  })
})
