import { describe, expect, it } from 'vitest'
import { findHasRestyleProblems } from './check-has-restyle-scope.mjs'

// Compiled shapes; each restyled the whole anchor subtree in the #34312 measurements.
// Rules need a declaration: lightningcss drops empty ones before the check sees them.
const subtreeWide = {
  'group-has-[…]/x': '.a:is(:where(.group\\/row):has(:is(:focus-visible)) *) { color: red }',
  'group-[:has(…)]/x': '.a:is(:where(.group\\/x):is(:has(:focus-visible)) *) { color: red }',
  'peer-[:has(…)]': '.a:is(:where(.peer):is(:has(.x)) ~ *) { color: red }',
  'peer-has-*': '.a:is(:where(.peer):has(:checked) ~ *) { color: red }',
  'not-group-has-[…]': '.a:not(:is(:where(.group):has(:is(.x)) *)) { color: red }',
  'group-not-has-[…]': '.a:is(:where(.group):not(:has(:is(.x))) *) { color: red }',
  '[&:has(x)]:*:': ':is(.a:has(.x) > *) { color: red }',
  '[&:has(x)]:**:': ':is(.a:has(.x) *) { color: red }',
  'has-[x]:**:': ':is(.a:has(:is(.x)) *) { color: red }',
  '[.row:has(x)_&_*]': '.row:has(.x) .a * { color: red }',
  'has-[x]:[&_svg]:': '.a:has(:is(.x)) svg { color: red }',
  '[&:has(x)_svg]': '.a:has(.x) svg { color: red }',
  '@apply group-has-*': '.foo:is(:where(.group\\/x):has(:is(:focus-visible)) *) { color: red }',
  'tag subject': '.zz:has(:focus-visible) span { color: red }',
  '::before subject': '.zz:has(.x) ::before { color: red }',
  '*::before subject': '.zz:has(.x) *::before { color: red }',
  ':hover subject': '.zz:has(.x) :hover { color: red }',
  ':not(.qq) subject': '.zz:has(.x) :not(.qq) { color: red }',
  'nested & *': '.zz:has(.x) { & * { color: red } }',
  ':is() keeps outer context': ':is(body:has(.modal)) span { color: red }',
  'inside @layer and @media':
    '@layer utilities { @media (hover: hover) { .zz:has(.x) span { color: red } } }'
}

const scoped = {
  'scoped group variant': "[class~='group/row']:has(:focus-visible) .a { color: red }",
  'subject :has()': '.card:has([data-slot="card-action"]) { color: red }',
  'sibling-only :has()': '.x .comment-md-p > strong:first-child:has(+ br) + br { color: red }',
  'global anchor, class subject': 'body:has(.qq) .yy { color: red }',
  ':is() anchor, class subject': ':is(body:has(.modal)) .x { color: red }',
  'group-hover': '.a:is(:where(.group\\/row):hover *) { color: red }',
  'subject :has() after a child combinator':
    "body > :is([data-slot='dialog-content']):has(~ [data-slot='dialog-overlay']) { color: red }"
}

describe('findHasRestyleProblems', () => {
  it.each(Object.entries(subtreeWide))('flags %s', (_name, css) => {
    expect(findHasRestyleProblems(css)).toHaveLength(1)
  })

  it.each(Object.entries(scoped))('allows %s', (_name, css) => {
    expect(findHasRestyleProblems(css)).toEqual([])
  })
})
