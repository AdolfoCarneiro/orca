// @vitest-environment happy-dom

import { afterAll, afterEach, expect, it } from 'vitest'
import { notifyEditorExternalFileChange } from '../../editor-autosave'
import type { DiffSection } from '../../diff-section-types'
import { disposeCombinedDiffViewMemory } from './combined-diff-view-memory'
import {
  claimCombinedDiffView,
  clearCombinedDiffViewMemory,
  forgetCombinedDiffViewBodiesForWorktree,
  forgetCombinedDiffViewsForWorktrees,
  forgetCombinedDiffViewsShowingPath,
  readCombinedDiffViewMemory,
  releaseCombinedDiffView,
  rememberCombinedDiffView,
  renameCombinedDiffViewOwner,
  type CachedCombinedDiffViewState
} from './combined-diff-view-cache'

afterEach(clearCombinedDiffViewMemory)
afterAll(disposeCombinedDiffViewMemory)

function section(path: string, overrides: Partial<DiffSection> = {}): DiffSection {
  return {
    key: path,
    path,
    status: 'M',
    originalContent: 'base',
    modifiedContent: 'changed',
    collapsed: false,
    loading: false,
    dirty: false,
    diffResult: null,
    largeDiffRenderLimit: null,
    ...overrides
  }
}

function remember(key: string, sections: DiffSection[], worktreeId = 'wt-a') {
  const lease = claimCombinedDiffView(key, worktreeId)
  const view: CachedCombinedDiffViewState = {
    entrySignature: 'entries',
    gitStatusSignature: 'status',
    sections,
    sectionHeights: { 0: 100 },
    loadedIndices: sections.map((_, index) => index),
    sideBySide: false
  }
  rememberCombinedDiffView(lease, { view, scrollTop: 320 })
  releaseCombinedDiffView(lease)
  return { lease, view }
}

for (const [views, sections, paths] of [
  [1, 100, 0],
  [1, 100, 10],
  [1, 1000, 100],
  [10, 1000, 100]
]) {
  it(`avoids repeated section-path scans for ${paths} absent paths across ${views} cached views of ${sections} sections`, () => {
    let pathReads = 0
    const initial = Array.from({ length: views }, (_, viewIndex) =>
      remember(
        `view-${viewIndex}`,
        Array.from({ length: sections }, (_, index) => {
          const file = section(`file-${index}.ts`)
          Object.defineProperty(file, 'path', {
            enumerable: true,
            get: () => {
              pathReads++
              return `file-${index}.ts`
            }
          })
          return file
        })
      )
    )
    pathReads = 0

    for (let index = 0; index < paths; index++) {
      notifyEditorExternalFileChange({
        worktreeId: 'wt-a',
        worktreePath: '/repo/workspace',
        relativePath: `absent-${index}.ts`
      })
    }

    expect(pathReads).toBe(paths === 0 ? 0 : views * sections)
    for (const [index, { view }] of initial.entries()) {
      expect(readCombinedDiffViewMemory(`view-${index}`)?.view).toBe(view)
      expect(readCombinedDiffViewMemory(`view-${index}`)?.scrollTop).toBe(320)
    }
  })
}

it('invalidates every clean exact-path section across owners while preserving protected bodies and metadata', () => {
  const sections = [
    section('same.ts', { key: 'staged:same.ts', contentGeneration: 4, error: 'old error' }),
    section('same.ts', { key: 'unstaged:same.ts' }),
    section('same.ts', { key: 'dirty', dirty: true }),
    section('same.ts', { key: 'conflict', saveConflict: true }),
    section('same.ts', { key: 'loading', loading: true }),
    section('same.ts', { key: 'deferred', loadOnDemand: true }),
    section('same.ts/child'),
    section('Same.ts'),
    section('same\\ts')
  ]
  const { view } = remember('local', sections)
  remember('other-owner', [section('same.ts')], 'wt-b')

  forgetCombinedDiffViewsShowingPath('same.ts')

  const updated = readCombinedDiffViewMemory('local')?.view
  expect(updated?.sections.slice(0, 2)).toEqual([
    {
      ...sections[0],
      originalContent: '',
      modifiedContent: '',
      loading: true,
      error: undefined,
      contentGeneration: 5
    },
    {
      ...sections[1],
      originalContent: '',
      modifiedContent: '',
      loading: true,
      error: undefined,
      contentGeneration: 1
    }
  ])
  expect(updated?.sections.slice(2)).toEqual(sections.slice(2))
  expect(updated?.sections.slice(2).every((file, index) => file === sections[index + 2])).toBe(true)
  expect(updated?.loadedIndices).toEqual([2, 3, 4, 5, 6, 7, 8])
  expect(updated?.sectionHeights).toBe(view.sectionHeights)
  expect(readCombinedDiffViewMemory('other-owner')?.view?.sections[0].loading).toBe(true)
})

it('keeps membership through content invalidation and rebuilds it when a later snapshot changes paths', () => {
  let otherPathReads = 0
  const other = section('other.ts')
  Object.defineProperty(other, 'path', {
    enumerable: true,
    get: () => {
      otherPathReads++
      return 'other.ts'
    }
  })
  const { lease } = remember('view', [section('first.ts'), other])

  forgetCombinedDiffViewsShowingPath('first.ts')
  otherPathReads = 0
  for (let index = 0; index < 100; index++) {
    forgetCombinedDiffViewsShowingPath(`absent-${index}.ts`)
  }
  expect(otherPathReads).toBe(0)
  forgetCombinedDiffViewsShowingPath('other.ts')
  expect(readCombinedDiffViewMemory('view')?.view?.sections.every((file) => file.loading)).toBe(
    true
  )

  const current = readCombinedDiffViewMemory('view')?.view
  if (!current) {
    throw new Error('Expected cached view')
  }
  const replacement = section('new.ts')
  rememberCombinedDiffView(lease, { view: { ...current, sections: [replacement, other] } })
  forgetCombinedDiffViewsShowingPath('first.ts')
  expect(readCombinedDiffViewMemory('view')?.view?.sections[0]).toBe(replacement)
  forgetCombinedDiffViewsShowingPath('new.ts')
  expect(readCombinedDiffViewMemory('view')?.view?.sections[0].loading).toBe(true)
  expect(readCombinedDiffViewMemory('view')?.view?.sections[0].modifiedContent).toBe('')
})

it('still invalidates an entire workspace on overflow after an absent-path lookup', () => {
  remember('local', [section('a.ts'), section('draft.ts', { dirty: true })])
  const { view: remote } = remember('other-owner', [section('a.ts')], 'wt-b')
  forgetCombinedDiffViewsShowingPath('absent.ts')

  forgetCombinedDiffViewBodiesForWorktree('wt-a')

  expect(readCombinedDiffViewMemory('local')?.view?.sections[0].loading).toBe(true)
  expect(readCombinedDiffViewMemory('local')?.view?.sections[1].modifiedContent).toBe('changed')
  expect(readCombinedDiffViewMemory('other-owner')?.view).toBe(remote)
})

it('preserves indexed sections through tab succession, owner rename and workspace deletion', () => {
  const lease = claimCombinedDiffView('closed-tab', 'wt-a', {
    contentKey: 'diff',
    scopeId: 'old',
    isScopeOpen: () => true
  })
  const { view } = remember('template', [section('a.ts')])
  rememberCombinedDiffView(lease, { view })
  releaseCombinedDiffView(lease)
  forgetCombinedDiffViewsShowingPath('absent.ts')

  const successor = claimCombinedDiffView('new-tab', 'wt-a', {
    contentKey: 'diff',
    scopeId: 'new',
    isScopeOpen: (scope) => scope === 'new'
  })
  expect(readCombinedDiffViewMemory('closed-tab')).toBeUndefined()
  expect(readCombinedDiffViewMemory('new-tab')?.view).toBe(view)
  renameCombinedDiffViewOwner('wt-a', 'wt-renamed')
  forgetCombinedDiffViewBodiesForWorktree('wt-a')
  expect(readCombinedDiffViewMemory('new-tab')?.view).toBe(view)
  forgetCombinedDiffViewBodiesForWorktree('wt-renamed')
  expect(readCombinedDiffViewMemory('new-tab')?.view?.sections[0].loading).toBe(true)

  forgetCombinedDiffViewsForWorktrees(['wt-renamed'])
  rememberCombinedDiffView(successor, { view })
  forgetCombinedDiffViewsShowingPath('a.ts')
  expect(readCombinedDiffViewMemory('new-tab')).toBeUndefined()
})

it('keeps the LRU order unchanged when priming membership and clears old view identities', () => {
  remember('oldest', [section('old.ts')])
  forgetCombinedDiffViewsShowingPath('absent.ts')
  for (let index = 0; index < 20; index++) {
    remember(`view-${index}`, [section(`file-${index}.ts`)])
  }
  expect(readCombinedDiffViewMemory('oldest')).toBeUndefined()
  expect(readCombinedDiffViewMemory('view-0')?.view?.sections[0].modifiedContent).toBe('changed')
  forgetCombinedDiffViewsShowingPath('file-19.ts')
  expect(readCombinedDiffViewMemory('view-19')?.view?.sections[0].loading).toBe(true)

  clearCombinedDiffViewMemory()
  const { view } = remember('view-19', [section('replacement.ts')])
  forgetCombinedDiffViewsShowingPath('file-19.ts')
  expect(readCombinedDiffViewMemory('view-19')?.view).toBe(view)
  forgetCombinedDiffViewsShowingPath('replacement.ts')
  expect(readCombinedDiffViewMemory('view-19')?.view?.sections[0].loading).toBe(true)
})
