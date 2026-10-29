import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { compileTailwind, findHasRestyleProblems } from './check-has-restyle-scope.mjs'

// Compiled shapes (the Tailwind spelling that emits each is noted); each restyles the whole anchor subtree.
// Rules need a declaration: lightningcss drops empty ones before the check sees them.
const subtreeWide = [
  '.a:is(:where(.group\\/row):has(:is(:focus-visible)) *)', // group-has-[…]/row
  '.a:is(:where(.group\\/x):is(:has(:focus-visible)) *)', // group-[:has(…)]/x
  '.a:is(:where(.peer):is(:has(.x)) ~ *)', // peer-[:has(…)]
  '.a:is(:where(.peer):has(:checked) ~ *)', // peer-has-checked
  '.a:not(:is(:where(.group):has(:is(.x)) *))', // not-group-has-[…]
  '.a:is(:where(.group):not(:has(:is(.x))) *)', // group-not-has-[…]
  ':is(.a:has(.x) > *)', // [&:has(x)]:*:
  ':is(.a:has(.x) *)', // [&:has(x)]:**:
  ':is(.a:has(:is(.x)) *)', // has-[x]:**:
  '.row:has(.x) .a *', // [.row:has(x)_&_*]
  '.a:has(:is(.x)) svg', // has-[x]:[&_svg]:
  '.a:has(.x) svg', // [&:has(x)_svg]
  ':is(.anchor:has(.trigger) .scoped) *', // [&:is(.anchor:has(.trigger)_.scoped)_*]
  ':where(.anchor:has(.trigger) .scoped) *',
  ':not(.anchor:has(.trigger) .scoped) *',
  '.a:nth-child(2n of .g:has(.x) *)',
  '.a:nth-last-child(2n of .g:has(.x) *)',
  '.zz:has(.a + .b) span',
  '.foo:has(.a ~ .b) *',
  '.zz:has(:focus-visible) span',
  '.zz:has(.x) ::before',
  '.zz:has(.x) *::before',
  '.zz:has(.x) :hover',
  '.zz:has(.x) :not(.qq)',
  ':is(body:has(.modal)) span'
]

const scoped = [
  "[class~='group/row']:has(:focus-visible) .a",
  '.card:has([data-slot="card-action"])',
  '.x .comment-md-p > strong:first-child:has(+ br) + br',
  '.zz:has(~ .y) span',
  'body:has(.qq) .yy',
  ':is(body:has(.modal)) .x',
  ':is(.anchor:has(.trigger) .scoped) .ok',
  '.a:is(:where(.group\\/row):hover *)',
  "body > :is([data-slot='dialog-content']):has(~ [data-slot='dialog-overlay'])"
]

describe('findHasRestyleProblems', () => {
  it.each(subtreeWide)('flags %s', (selector) => {
    expect(findHasRestyleProblems(`${selector} { color: red }`)).toHaveLength(1)
  })

  it.each(scoped)('allows %s', (selector) => {
    expect(findHasRestyleProblems(`${selector} { color: red }`)).toEqual([])
  })

  it('sees rules through nesting, @layer and @media', () => {
    expect(findHasRestyleProblems('.zz:has(.x) { & * { color: red } }')).toHaveLength(1)
    expect(
      findHasRestyleProblems('@layer u { @media (hover: hover) { .zz:has(.x) i { color: red } } }')
    ).toHaveLength(1)
  })

  it('refuses a :has() rule the parser had to recover past', () => {
    expect(findHasRestyleProblems('.zz:has(.x)) span { color: red }')).toEqual([
      'unparsed: .zz:has(.x)) span { color: red }'
    ])
  })

  it('flags a group-has-* utility through the real Tailwind compile', async () => {
    const css = await compileTailwind(
      "@import 'tailwindcss/utilities' source(none);\n@source inline('group-has-[:focus-visible]/row:opacity-100');",
      { base: path.resolve(import.meta.dirname, '../../src/renderer/src/assets') }
    )
    expect(findHasRestyleProblems(css)).toEqual([
      '.group-has-\\[\\:focus-visible\\]\\/row\\:opacity-100:is(:where(.group\\/row):has(:focus-visible) *)'
    ])
  })
})
