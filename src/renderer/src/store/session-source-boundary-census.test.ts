import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SESSION_SOURCE_FIELDS, SESSION_SOURCE_KINDS } from '../lib/session-source-fields'
import { composeSessionSourceWrites } from './session-source-compose'
import { editSessionSource } from './session-source-edits'

function productionFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory()
      ? /test-support|fixtures/.test(entry.name)
        ? []
        : productionFiles(path)
      : /\.tsx?$/.test(entry.name) &&
          !/\.test\.|\.spec\.|test-fixture|test-harness|store-test-helpers/.test(entry.name)
        ? [path]
        : []
  })
}

describe('session source boundary completeness', () => {
  it('classifies every source field exactly once', () => {
    expect(Object.keys(SESSION_SOURCE_KINDS).sort()).toEqual([...SESSION_SOURCE_FIELDS].sort())
  })

  it('keeps receipt-symbol access and write assertions inside the boundary', () => {
    const root = join(process.cwd(), 'src/renderer/src')
    const boundaries = new Set([
      'store/session-source-edits.ts',
      'store/session-source-write-boundary.ts',
      'store/editor-buffer-record-lifecycle.ts'
    ])
    const violations = productionFiles(root).flatMap((path) => {
      if (boundaries.has(relative(root, path))) {
        return []
      }
      return /SESSION_SOURCE_RECEIPT|\bas\s+SessionSourceWrite\b/.test(readFileSync(path, 'utf8'))
        ? [relative(root, path)]
        : []
    })
    expect(violations).toEqual([])
  })

  it('refuses parallel whole-map partials and permits a sequential middleware chain', () => {
    const before = { editorDrafts: { a: 'A', b: 'B' } }
    const first = editSessionSource(before).set('editorDrafts', 'a', 'next').finish()
    const competing = editSessionSource(before).set('editorDrafts', 'b', 'next').finish()
    expect(() => composeSessionSourceWrites([first, competing])).toThrow(
      'Composed source writes overlap: editorDrafts'
    )
    const next = { ...before, ...first }
    const middleware = editSessionSource(next).set('editorDrafts', 'b', 'joined').finish()
    expect(composeSessionSourceWrites([first, middleware], true).editorDrafts).toEqual({
      a: 'next',
      b: 'joined'
    })
  })
})
