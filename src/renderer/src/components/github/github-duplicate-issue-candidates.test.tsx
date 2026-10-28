// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import { useAppStore } from '@/store'
import { useGitHubDuplicateIssueCandidates } from './github-duplicate-issue-candidates'

type WorkItemsCache = ReturnType<typeof useAppStore.getState>['workItemsCache']

const originalCache = useAppStore.getState().workItemsCache
const originalActiveTabId = useAppStore.getState().activeTabId

function issue(number: number, overrides: Partial<GitHubWorkItem> = {}): GitHubWorkItem {
  return {
    id: `issue:${number}`,
    type: 'issue',
    number,
    title: `Issue ${number}`,
    repoId: 'repo-1',
    state: 'open',
    url: `https://github.com/acme/widgets/issues/${number}`,
    labels: [],
    updatedAt: '',
    author: null,
    ...overrides
  }
}

function cacheWithRows(rows: readonly GitHubWorkItem[]): WorkItemsCache {
  const rowsPerEntry = 20
  return Object.fromEntries(
    Array.from({ length: Math.ceil(rows.length / rowsPerEntry) }, (_, entry) => [
      `query-${entry}`,
      { data: rows.slice(entry * rowsPerEntry, (entry + 1) * rowsPerEntry), fetchedAt: 1 }
    ])
  )
}

function unrelatedWrites(): void {
  act(() => {
    for (let update = 0; update < 50; update += 1) {
      useAppStore.setState({ activeTabId: `unrelated-${update}` })
    }
  })
}

afterEach(() => {
  cleanup()
  useAppStore.setState({ workItemsCache: originalCache, activeTabId: originalActiveTabId })
})

describe('duplicate issue candidates', () => {
  it.each([100, 1_000])(
    'does not rescan %i cached rows on unrelated writes while open',
    (rowCount) => {
      let candidateReads = 0
      const rows = Array.from({ length: rowCount }, (_, index) => {
        const row = issue(index + 1)
        Object.defineProperty(row, 'type', {
          enumerable: true,
          get: () => {
            candidateReads += 1
            return 'issue'
          }
        })
        return row
      })
      useAppStore.setState({ workItemsCache: cacheWithRows(rows) })
      const { result } = renderHook(() =>
        useGitHubDuplicateIssueCandidates({ repoId: 'repo-1', number: 2_000 }, true)
      )
      expect(result.current).toHaveLength(rowCount)
      const selected = result.current
      candidateReads = 0

      unrelatedWrites()

      expect(result.current).toBe(selected)
      expect(candidateReads).toBe(0)
    }
  )

  it('does no candidate work while closed, including after cache replacement', () => {
    let candidateReads = 0
    const row = issue(1)
    Object.defineProperty(row, 'type', {
      enumerable: true,
      get: () => {
        candidateReads += 1
        return 'issue'
      }
    })
    useAppStore.setState({ workItemsCache: { initial: { data: [row], fetchedAt: 1 } } })
    const { result } = renderHook(() =>
      useGitHubDuplicateIssueCandidates({ repoId: 'repo-1', number: 2_000 }, false)
    )
    expect(result.current).toEqual([])
    unrelatedWrites()
    act(() => {
      useAppStore.setState({ workItemsCache: { replaced: { data: [row], fetchedAt: 2 } } })
    })
    expect(result.current).toEqual([])
    expect(candidateReads).toBe(0)
  })

  it('preserves filtering, first-match deduplication, descending order and picker inputs', () => {
    const five = issue(5)
    const ten = issue(10)
    const eight = issue(8)
    const seven = issue(7)
    const otherRepo = issue(100, { repoId: 'repo-2' })
    useAppStore.setState({
      workItemsCache: {
        initial: { data: [five, ten, issue(99, { type: 'pr' }), otherRepo, eight], fetchedAt: 1 },
        later: { data: [issue(10, { title: 'Later duplicate' }), seven], fetchedAt: 2 }
      }
    })
    const { result, rerender } = renderHook(
      ({ repoId, number }) => useGitHubDuplicateIssueCandidates({ repoId, number }, true),
      { initialProps: { repoId: 'repo-1', number: 8 } }
    )
    expect(result.current).toEqual([ten, seven, five])
    expect(result.current[0]).toBe(ten)
    rerender({ repoId: 'repo-2', number: 8 })
    expect(result.current).toEqual([otherRepo])
    rerender({ repoId: 'repo-1', number: 10 })
    expect(result.current).toEqual([eight, seven, five])
  })

  it('updates on immutable replacement/removal and reopening after a closed update', () => {
    const initial = issue(1)
    const updated = issue(1, { title: 'Updated' })
    useAppStore.setState({ workItemsCache: { query: { data: [initial], fetchedAt: 1 } } })
    const { result, rerender } = renderHook(
      ({ open }) => useGitHubDuplicateIssueCandidates({ repoId: 'repo-1', number: 2_000 }, open),
      { initialProps: { open: true } }
    )
    expect(result.current).toEqual([initial])
    act(() => {
      useAppStore.setState({ workItemsCache: { query: { data: [updated], fetchedAt: 2 } } })
    })
    expect(result.current[0]).toBe(updated)
    rerender({ open: false })
    expect(result.current).toEqual([])
    act(() => {
      useAppStore.setState({ workItemsCache: {} })
    })
    rerender({ open: true })
    expect(result.current).toEqual([])
  })

  it('does not rerender when cache changes leave the same candidate rows', () => {
    const initial = issue(1)
    const cache = { query: { data: [initial], fetchedAt: 1 } }
    useAppStore.setState({ workItemsCache: cache })
    let renders = 0
    const { result } = renderHook(() => {
      renders += 1
      return useGitHubDuplicateIssueCandidates({ repoId: 'repo-1', number: 2_000 }, true)
    })
    const selected = result.current
    const initialRenders = renders
    act(() => {
      useAppStore.setState({
        workItemsCache: {
          ...cache,
          other: { data: [issue(100, { repoId: 'repo-2' })], fetchedAt: 2 }
        }
      })
    })
    expect(result.current).toBe(selected)
    expect(renders).toBe(initialRenders)
  })

  it('keeps simultaneous picker inputs independent', () => {
    const one = issue(1)
    const otherRepo = issue(1, { repoId: 'repo-2' })
    useAppStore.setState({ workItemsCache: { query: { data: [one, otherRepo], fetchedAt: 1 } } })
    const { result } = renderHook(() => [
      useGitHubDuplicateIssueCandidates({ repoId: 'repo-1', number: 2_000 }, true),
      useGitHubDuplicateIssueCandidates({ repoId: 'repo-2', number: 2_000 }, true)
    ])
    expect(result.current).toEqual([[one], [otherRepo]])
    const updated = issue(1, { title: 'Updated' })
    act(() => {
      useAppStore.setState({
        workItemsCache: { query: { data: [updated, otherRepo], fetchedAt: 2 } }
      })
    })
    expect(result.current).toEqual([[updated], [otherRepo]])
  })
})
