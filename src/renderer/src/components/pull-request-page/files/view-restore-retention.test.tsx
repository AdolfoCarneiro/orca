// @vitest-environment happy-dom

import { act, useRef } from 'react'
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DiffSection } from '@/components/editor/diff-section-types'
import { prFilesDiffScrollTopCache, prFilesDiffViewStateCache } from '../cache/files-diff-view'
import { loadPRFileContents } from '../cache/file-content'
import { usePRFileSectionLoader } from './section-loader'
import { usePRFilesDiffViewPersistence } from './view-restore'

vi.mock('../cache/file-content', () => ({
  loadPRFileContents: vi.fn(),
  evictPRFileContentRequest: vi.fn()
}))

function sections(count = 2): DiffSection[] {
  return Array.from({ length: count }, (_, index) => {
    const originalContent = 'a'.repeat(750_000)
    const modifiedContent = 'b'.repeat(750_000)
    return {
      key: `file-${index}`,
      path: `src/file-${index}.ts`,
      status: 'modified',
      originalContent,
      modifiedContent,
      loading: false,
      collapsed: index === 1,
      dirty: false,
      largeDiffRenderLimit: null,
      diffResult: {
        kind: 'text',
        originalContent,
        modifiedContent,
        originalIsBinary: false,
        modifiedIsBinary: false
      }
    }
  })
}

function mountView(key: string, rows: DiffSection[], container: HTMLDivElement | null = null) {
  return renderHook(() =>
    usePRFilesDiffViewPersistence({
      sections: rows,
      entriesLength: rows.length,
      viewStateKey: key,
      entrySignature: `signature-${key}`,
      sectionHeights: { 0: 600, 1: 700 },
      sideBySide: true,
      fileTreeCollapsed: true,
      activeTreeSectionKey: 'file-1',
      loadedIndicesRef: useRef(new Set(rows.map((_, index) => index))),
      scrollContainerRef: useRef(container),
      pendingRestoreScrollTopRef: useRef(null)
    })
  )
}

function bodyCharacters(): number {
  let characters = 0
  for (const view of prFilesDiffViewStateCache.values()) {
    for (const section of view.sections) {
      characters += section.originalContent.length + section.modifiedContent.length
    }
  }
  return characters
}

function stored(key: string) {
  const view = prFilesDiffViewStateCache.get(key)
  expect(view).toBeDefined()
  if (!view) {
    throw new Error(`missing view: ${key}`)
  }
  return view
}

afterEach(() => {
  cleanup()
  prFilesDiffViewStateCache.clear()
  prFilesDiffScrollTopCache.clear()
  vi.clearAllMocks()
})

describe('PR Files inactive view bodies', () => {
  it.each([2, 20])(
    'bounds reloadable bodies after %i PR visits and keeps restoration metadata',
    (count) => {
      for (let index = 0; index < count; index++) {
        const key = `pr-${index}`
        prFilesDiffScrollTopCache.set(key, 100 + index)
        mountView(key, sections()).unmount()
      }

      expect(prFilesDiffViewStateCache.size).toBe(count)
      expect(bodyCharacters()).toBeLessThanOrEqual(16_000_000)
      if (count === 2) {
        expect(bodyCharacters()).toBe(6_000_000)
      }
      for (let index = 0; index < count; index++) {
        expect(stored(`pr-${index}`)).toMatchObject({
          entrySignature: `signature-pr-${index}`,
          sectionHeights: { 0: 600, 1: 700 },
          scrollTop: 100 + index,
          sideBySide: true,
          fileTreeCollapsed: true,
          activeTreeSectionKey: 'file-1',
          sections: [
            { key: 'file-0', collapsed: false },
            { key: 'file-1', collapsed: true }
          ]
        })
      }
      expect(stored(`pr-${count - 1}`).loadedIndices).toEqual([0, 1])
      expect(stored('pr-0').sections[0].loading).toBe(count === 20)
    }
  )

  it('protects mounted bodies until the last owner of a key unmounts', () => {
    const rows = sections(12)
    const first = mountView('open-pr', rows)
    const second = mountView('open-pr', rows)
    first.unmount()
    expect(stored('open-pr').sections).toBe(rows)
    expect(bodyCharacters()).toBe(18_000_000)

    second.unmount()
    expect(bodyCharacters()).toBe(0)
    expect(stored('open-pr').loadedIndices).toEqual([])
  })

  it('reuses warm bodies when a PR is revisited below budget', () => {
    const rows = sections()
    mountView('warm-pr', rows).unmount()
    const cached = stored('warm-pr')
    mountView('warm-pr', cached.sections).unmount()
    expect(stored('warm-pr').sections).toBe(rows)
    expect(stored('warm-pr').loadedIndices).toEqual([0, 1])
  })

  it('preserves loaded rows with no reloadable body when pruning a large view', () => {
    const rows = sections(12)
    const unavailable: DiffSection = {
      ...rows[0],
      key: 'unavailable',
      path: 'unavailable.ts',
      originalContent: '',
      modifiedContent: '',
      diffResult: null,
      error: 'unavailable'
    }
    mountView('mixed-pr', [...rows, unavailable]).unmount()
    expect(bodyCharacters()).toBe(0)
    expect(stored('mixed-pr').sections[12]).toBe(unavailable)
    expect(stored('mixed-pr').loadedIndices).toEqual([12])
  })

  it('does not rescan retired section bodies during scroll writes', () => {
    const rows = sections()
    const original = rows[0]
    let reads = 0
    rows[0] = {
      ...original,
      get originalContent() {
        reads++
        return original.originalContent
      }
    }
    mountView('retired-pr', rows).unmount()
    const initialReads = reads
    const container = document.createElement('div')
    mountView('scrolling-pr', sections(), container)
    for (let index = 0; index < 100; index++) {
      act(() => {
        container.scrollTop = index
        container.dispatchEvent(new Event('scroll'))
      })
    }
    expect(reads).toBe(initialReads)
    expect(stored('scrolling-pr').scrollTop).toBe(99)
  })

  it('reloads a released row through the production section loader', async () => {
    mountView('large-pr', sections(12)).unmount()
    const cached = stored('large-pr')
    const sectionsRef = { current: cached.sections }
    const loadedIndicesRef = { current: new Set(cached.loadedIndices) }
    const result = renderHook(() =>
      usePRFileSectionLoader({
        sectionsRef,
        loadedIndicesRef,
        loadingIndicesRef: useRef(new Set<number>()),
        generationRef: useRef(0),
        fileByPath: new Map([
          [
            'src/file-0.ts',
            {
              path: 'src/file-0.ts',
              status: 'modified',
              additions: 1,
              deletions: 1,
              isBinary: false
            }
          ]
        ]),
        repoPath: '/repo',
        repoId: 'repo',
        prNumber: 42,
        headSha: 'head',
        baseSha: 'base',
        setSections: (update) => {
          sectionsRef.current = typeof update === 'function' ? update(sectionsRef.current) : update
        },
        setSectionHeights: () => {}
      })
    )
    vi.mocked(loadPRFileContents).mockResolvedValue({
      original: 'refetched before',
      modified: 'refetched after',
      originalIsBinary: false,
      modifiedIsBinary: false
    })
    await act(async () => result.result.current.loadSection(0))
    expect(loadPRFileContents).toHaveBeenCalledTimes(1)
    expect(sectionsRef.current[0]).toMatchObject({
      originalContent: 'refetched before',
      modifiedContent: 'refetched after',
      loading: false,
      contentGeneration: 1
    })
    expect(loadedIndicesRef.current.has(0)).toBe(true)
  })
})
