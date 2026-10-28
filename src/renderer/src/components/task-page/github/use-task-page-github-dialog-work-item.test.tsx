// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import { useAppStore } from '@/store'
import type { TaskPageDialogWorkItemKey } from '../task-page-cache-selectors'
import { useTaskPageGitHubDialogWorkItem } from './use-task-page-github-dialog-work-item'

type WorkItemsCache = ReturnType<typeof useAppStore.getState>['workItemsCache']

const originalCache = useAppStore.getState().workItemsCache
const originalActiveTabId = useAppStore.getState().activeTabId

function issue(number: number, overrides: Partial<GitHubWorkItem> = {}): GitHubWorkItem {
  return {
    id: `issue-${number}`,
    type: 'issue',
    number,
    title: `Issue ${number}`,
    repoId: 'repo-1',
    repoHostId: 'local',
    state: 'open',
    url: `https://github.com/acme/widgets/issues/${number}`,
    labels: [],
    updatedAt: '',
    author: null,
    ...overrides
  }
}

function key(item: GitHubWorkItem): TaskPageDialogWorkItemKey {
  return { id: item.id, repoId: item.repoId, url: item.url, repoHostId: item.repoHostId }
}

function cacheWithRows(rows: readonly GitHubWorkItem[]): WorkItemsCache {
  return Object.fromEntries(
    Array.from({ length: Math.ceil(rows.length / 20) }, (_, entry) => [
      `query-${entry}`,
      { data: rows.slice(entry * 20, (entry + 1) * 20), fetchedAt: 1 }
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

describe('task page GitHub dialog cache selection', () => {
  it.each([100, 1_000])('does not rescan %i cached rows on unrelated writes', (rowCount) => {
    let idReads = 0
    const rows = Array.from({ length: rowCount }, (_, index) => {
      const row = issue(index + 1)
      const id = row.id
      Object.defineProperty(row, 'id', {
        enumerable: true,
        get: () => {
          idReads += 1
          return id
        }
      })
      return row
    })
    const target = rows[rowCount - 1]
    const targetKey = key(target)
    useAppStore.setState({ workItemsCache: cacheWithRows(rows) })
    const { result, rerender } = renderHook(
      ({ itemKey }: { itemKey: TaskPageDialogWorkItemKey }) =>
        useTaskPageGitHubDialogWorkItem(itemKey),
      { initialProps: { itemKey: targetKey } }
    )
    expect(result.current).toBe(target)
    idReads = 0

    unrelatedWrites()

    expect(result.current).toBe(target)
    expect(idReads).toBe(0)
    rerender({ itemKey: targetKey && { ...targetKey } })
    expect(result.current).toBe(target)
    expect(idReads).toBe(0)
  })

  it('does no row work without an open conversation, including after cache replacement', () => {
    let idReads = 0
    const row = issue(1)
    Object.defineProperty(row, 'id', {
      enumerable: true,
      get: () => {
        idReads += 1
        return 'issue-1'
      }
    })
    useAppStore.setState({ workItemsCache: cacheWithRows([row]) })
    const { result } = renderHook(() => useTaskPageGitHubDialogWorkItem(null))
    unrelatedWrites()
    act(() => {
      useAppStore.setState({ workItemsCache: { replaced: { data: [row], fetchedAt: 2 } } })
    })
    expect(result.current).toBeNull()
    expect(idReads).toBe(0)
  })

  it('preserves source and host identity, first-match order, and key changes', () => {
    const target = issue(1)
    const otherId = issue(2, { url: target.url })
    const otherRepo = issue(1, { repoId: 'repo-2' })
    const upstream = issue(1, { url: 'https://github.com/upstream/widgets/issues/1' })
    const remote = issue(1, { repoHostId: 'ssh:build' })
    useAppStore.setState({
      workItemsCache: {
        first: { data: [otherId, otherRepo, upstream, remote, target], fetchedAt: 1 },
        later: { data: [issue(1, { title: 'Later copy' })], fetchedAt: 2 }
      }
    })
    const { result, rerender } = renderHook(
      ({ itemKey }: { itemKey: TaskPageDialogWorkItemKey }) =>
        useTaskPageGitHubDialogWorkItem(itemKey),
      { initialProps: { itemKey: key(target) } }
    )
    expect(result.current).toBe(target)
    for (const row of [otherId, otherRepo, upstream, remote]) {
      rerender({ itemKey: key(row) })
      expect(result.current).toBe(row)
    }
    rerender({ itemKey: { id: target.id, repoId: target.repoId, url: target.url } })
    expect(result.current).toBe(remote)
    rerender({ itemKey: key(issue(3)) })
    expect(result.current).toBeNull()
  })

  it('updates on immutable replacement, removal, and a closed-cache update before reopening', () => {
    const initial = issue(1)
    const updated = issue(1, { title: 'Updated' })
    useAppStore.setState({ workItemsCache: cacheWithRows([initial]) })
    const { result, rerender } = renderHook(
      ({ itemKey }: { itemKey: TaskPageDialogWorkItemKey }) =>
        useTaskPageGitHubDialogWorkItem(itemKey),
      { initialProps: { itemKey: key(initial) } }
    )
    expect(result.current).toBe(initial)
    act(() => {
      useAppStore.setState({ workItemsCache: cacheWithRows([updated]) })
    })
    expect(result.current).toBe(updated)
    act(() => {
      useAppStore.setState({ workItemsCache: {} })
    })
    expect(result.current).toBeNull()
    rerender({ itemKey: null })
    act(() => {
      useAppStore.setState({ workItemsCache: cacheWithRows([updated]) })
    })
    expect(result.current).toBeNull()
    rerender({ itemKey: key(initial) })
    expect(result.current).toBe(updated)
  })

  it('keeps simultaneous conversations independent across input and cache changes', () => {
    const one = issue(1)
    const two = issue(2)
    useAppStore.setState({ workItemsCache: cacheWithRows([one, two]) })
    const first = renderHook(
      ({ itemKey }: { itemKey: TaskPageDialogWorkItemKey }) =>
        useTaskPageGitHubDialogWorkItem(itemKey),
      { initialProps: { itemKey: key(one) } }
    )
    const second = renderHook(() => useTaskPageGitHubDialogWorkItem(key(two)))
    expect(first.result.current).toBe(one)
    expect(second.result.current).toBe(two)
    first.rerender({ itemKey: null })
    const updatedTwo = issue(2, { state: 'closed' })
    act(() => {
      useAppStore.setState({ workItemsCache: cacheWithRows([one, updatedTwo]) })
    })
    expect(first.result.current).toBeNull()
    expect(second.result.current).toBe(updatedTwo)
    first.rerender({ itemKey: key(one) })
    expect(first.result.current).toBe(one)
    expect(second.result.current).toBe(updatedTwo)
  })

  it('does not rerender when an unrelated cache entry changes and the chosen row is unchanged', () => {
    const target = issue(1)
    const cache = cacheWithRows([target])
    useAppStore.setState({ workItemsCache: cache })
    let renders = 0
    const { result } = renderHook(() => {
      renders += 1
      return useTaskPageGitHubDialogWorkItem(key(target))
    })
    const initialRenders = renders
    act(() => {
      useAppStore.setState({
        workItemsCache: { ...cache, other: { data: [issue(3)], fetchedAt: 2 } }
      })
    })
    expect(result.current).toBe(target)
    expect(renders).toBe(initialRenders)
  })
})
