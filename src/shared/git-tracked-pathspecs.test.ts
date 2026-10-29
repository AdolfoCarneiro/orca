import { describe, expect, it, vi } from 'vitest'
import { isTrackedPathSpec, partitionTrackedPathSpecs } from './git-tracked-pathspecs'

function countNormalizations(run: () => unknown): number {
  const replace = vi.spyOn(String.prototype, 'replace')
  try {
    run()
    return replace.mock.calls.filter(
      ([pattern]) => pattern instanceof RegExp && pattern.source === '\\\\'
    ).length
  } finally {
    replace.mockRestore()
  }
}

describe('tracked pathspec partition', () => {
  it.each([100, 1_000])('indexes repeated matches across %i tracked paths', (size) => {
    const paths = Array.from({ length: size }, (_, index) => `docs/file-${index}`)
    const prefixes = new Set(paths.map((name) => `${name}/`))
    const startsWith = String.prototype.startsWith
    let comparisons = 0
    const spy = vi.spyOn(String.prototype, 'startsWith').mockImplementation(function (
      this: string,
      searchString: string,
      position?: number
    ) {
      if (prefixes.has(searchString)) {
        comparisons += 1
      }
      return startsWith.call(this, searchString, position)
    })
    try {
      expect(partitionTrackedPathSpecs(paths, paths)).toEqual({
        trackedPaths: paths,
        untrackedPaths: []
      })
      expect(comparisons).toBeLessThanOrEqual(size * (Math.ceil(Math.log2(size)) + 1))
    } finally {
      spy.mockRestore()
    }
  })

  it.each([
    ['docs', ['docs/readme.md'], true],
    ['doc', ['docs/readme.md'], false],
    ['docs/file', ['docs/file-extra'], false],
    ['docs///', ['docs\\readme.md'], true],
    ['src\\file.ts\\', ['src/file.ts///'], true],
    ['DOCS', ['docs/readme.md'], false],
    ['./docs', ['docs/readme.md'], false],
    ['docs//file', ['docs/file'], false],
    ['docs/../file', ['file'], false],
    ['[ab].txt', ['a.txt'], false],
    ['[ab].txt', ['[ab].txt'], true],
    [':(glob)*', ['a.txt'], false],
    ['a b/é', ['a b/é/file\nname'], true],
    ['é', ['e\u0301'], false],
    ['C:\\repo\\docs', ['C:/repo/docs/file'], true],
    ['\\\\host\\share', ['//host/share/file'], true],
    ['', [], false],
    ['', ['relative'], false],
    ['', ['/absolute'], true],
    ['/', [''], true]
  ] as const)('keeps matching semantics for %j against %j', (request, tracked, expected) => {
    expect(isTrackedPathSpec(request, tracked)).toBe(expected)
    expect(partitionTrackedPathSpecs([request], tracked)).toEqual(
      expected
        ? { trackedPaths: [request], untrackedPaths: [] }
        : { trackedPaths: [], untrackedPaths: [request] }
    )
  })

  it('preserves original spelling, duplicates and relative order in both action lists', () => {
    const requests = ['new', 'docs\\', '[ab].txt', 'docs///', 'new', 'src/file', 'docs\\']
    const tracked = ['docs/readme', 'src/file-extra', '[ab].txt', 'docs/readme']
    expect(partitionTrackedPathSpecs(requests, tracked)).toEqual({
      trackedPaths: ['docs\\', '[ab].txt', 'docs///', 'docs\\'],
      untrackedPaths: ['new', 'new', 'src/file']
    })
  })

  it('normalizes each visited tracked entry once and each request once per operation', () => {
    const requests = Array.from({ length: 64 }, (_, index) => `missing/${index}`)
    const tracked = Array.from({ length: 256 }, (_, index) => `docs\\file-${index}///`)
    expect(countNormalizations(() => partitionTrackedPathSpecs(requests, tracked))).toBe(320)
  })

  it('retains early exit for a selected directory with many tracked descendants', () => {
    const tracked = Array.from({ length: 64 }, (_, index) => `docs/file-${index}`)
    expect(countNormalizations(() => partitionTrackedPathSpecs(['docs'], tracked))).toBe(2)
    expect(countNormalizations(() => partitionTrackedPathSpecs([], tracked))).toBe(0)
  })

  it('keeps repeated first-descendant matches lazy', () => {
    const requests = Array.from({ length: 1_000 }, () => 'docs')
    const tracked = Array.from({ length: 1_000 }, (_, index) => `docs/file-${index}`)
    expect(countNormalizations(() => partitionTrackedPathSpecs(requests, tracked))).toBe(1_001)
  })

  it('avoids sorting for a missing request followed by one early directory match', () => {
    const tracked = Array.from({ length: 1_000 }, (_, index) => `docs/file-${index}`)
    const sort = vi.spyOn(Array.prototype, 'sort')
    let sorts: number
    try {
      partitionTrackedPathSpecs(['missing', 'docs'], tracked)
      sorts = sort.mock.calls.length
    } finally {
      sort.mockRestore()
    }
    expect(sorts).toBe(0)
  })

  it('does not build an index only for the last request', () => {
    const tracked = Array.from({ length: 64 }, (_, index) => `docs/file-${index}`)
    const requests = [...Array.from({ length: 400 }, () => 'docs'), 'missing']
    const sort = vi.spyOn(Array.prototype, 'sort')
    let sorts: number
    try {
      partitionTrackedPathSpecs(requests, tracked)
      sorts = sort.mock.calls.length
    } finally {
      sort.mockRestore()
    }
    expect(sorts).toBe(0)
  })

  it('finds descendants after nonchild lexical neighbors when repeated scans build an index', () => {
    const requests = ['missing', 'missing', 'docs', 'docs-extra', 'doc', '']
    const tracked = ['docs-extra', 'docs/file', 'docs/file', '/absolute']
    expect(partitionTrackedPathSpecs(requests, tracked)).toEqual({
      trackedPaths: ['docs', 'docs-extra', ''],
      untrackedPaths: ['missing', 'missing', 'doc']
    })
  })

  it('does not reuse tracked evidence across operations', () => {
    expect(partitionTrackedPathSpecs(['docs'], ['docs/file']).trackedPaths).toEqual(['docs'])
    expect(partitionTrackedPathSpecs(['docs'], []).untrackedPaths).toEqual(['docs'])
  })
})
