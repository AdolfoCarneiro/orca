// @vitest-environment happy-dom

import { useEffect, type ComponentProps } from 'react'
import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiffSection } from '@/components/editor/diff-section-types'
import type { GitHubPRFile } from '../../../../../shared/github/pull-request-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import {
  getPRFilesDiffViewKey,
  prFilesDiffScrollTopCache,
  prFilesDiffViewStateCache
} from '../cache/files-diff-view'
import { PullRequestPageTabs } from './tabs-shell'

const transport = vi.hoisted(() => ({ rpc: vi.fn() }))

vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: transport.rpc }))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: { settings: { theme: string } }) => unknown) =>
    selector({ settings: { theme: 'dark' } })
}))
vi.mock('@/hooks/use-document-dark-theme', () => ({ useDocumentDarkTheme: () => true }))
vi.mock('../conversation/tab', () => ({ ConversationTab: () => <div>Conversation</div> }))
vi.mock('../checks/tab', () => ({ ChecksTab: () => null }))
vi.mock('../cache/work-item-details', () => ({
  patchCachedPRChecks: () => {},
  patchCachedPRReviewRequests: () => {},
  patchCachedWorkItemBody: () => {}
}))
vi.mock('../files/line-comment', () => ({ addPullRequestLineComment: () => {} }))
vi.mock('../files/toolbar', () => ({ PRFilesDiffToolbar: () => null }))
vi.mock('../../editor/combined-diff/browse-files/combined-diff-file-tree', () => ({
  CombinedDiffFileTree: () => null
}))
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    measure: () => {},
    measureElement: () => {},
    scrollToIndex: () => {},
    getTotalSize: () => count * 100,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ key: index, index, start: index * 100 }))
  })
}))
vi.mock('@/components/editor/DiffSectionItem', () => ({
  DiffSectionItem: function SectionProbe({
    section,
    index,
    loadSection
  }: {
    section: DiffSection
    index: number
    loadSection: (index: number) => void
  }) {
    useEffect(() => loadSection(index), [index, loadSection])
    return <div data-file-loading={section.loading}>{section.path}</div>
  }
}))

const files: GitHubPRFile[] = Array.from({ length: 20 }, (_, index) => ({
  path: `src/file-${String(index).padStart(2, '0')}.ts`,
  status: 'modified',
  additions: 1,
  deletions: 1,
  isBinary: false
}))

function page(
  prNumber = 42,
  hostId: TaskSourceContext['hostId'] = 'runtime:file-lifetime'
): ComponentProps<typeof PullRequestPageTabs> {
  const sourceContext: TaskSourceContext = {
    kind: 'task-source',
    provider: 'github',
    hostId,
    projectId: 'project',
    projectHostSetupId: 'setup',
    repoId: 'repo'
  }
  const workItem = {
    id: `pr-${prNumber}`,
    type: 'pr' as const,
    number: prNumber,
    title: 'Review',
    state: 'open' as const,
    url: `https://github.com/owner/repo/pull/${prNumber}`,
    labels: [],
    updatedAt: '2026-10-28T00:00:00Z',
    author: null,
    repoId: 'repo'
  }
  return {
    tab: 'files',
    onTabChange: () => {},
    workItem,
    displayWorkItem: null,
    repoPath: '/repo',
    effectiveRepoId: 'repo',
    sourceContext,
    projectOrigin: undefined,
    body: '',
    comments: [],
    files,
    filesUnavailable: false,
    checks: [],
    loading: false,
    detailsLoaded: true,
    details: { item: workItem, body: '', comments: [], headSha: 'head', baseSha: 'base' },
    localState: 'open',
    setLocalState: () => {},
    detailsCacheKey: null,
    pendingViewedPaths: new Set(),
    invalidateCurrentDetailsCache: () => {},
    appendOptimisticComment: () => {},
    handlePRFileViewedChange: async () => true
  }
}

function cached(props: ComponentProps<typeof PullRequestPageTabs>) {
  const key = getPRFilesDiffViewKey({
    repoId: props.effectiveRepoId ?? '',
    repoPath: props.repoPath ?? '',
    prNumber: props.workItem.number,
    prRepo: { owner: 'owner', repo: 'repo', host: 'github.com' },
    sourceHostId: props.sourceContext?.hostId
  })
  const value = prFilesDiffViewStateCache.get(key)
  if (!value) {
    throw new Error('Missing production Files view cache')
  }
  return value
}

function characters(props: ComponentProps<typeof PullRequestPageTabs>): number {
  return cached(props).sections.reduce(
    (total, section) => total + section.originalContent.length + section.modifiedContent.length,
    0
  )
}

async function loaded(props: ComponentProps<typeof PullRequestPageTabs>): Promise<void> {
  await waitFor(() => expect(cached(props).loadedIndices).toHaveLength(20))
  expect(characters(props)).toBe(30_000_000)
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  transport.rpc.mockResolvedValue({
    original: 'a'.repeat(750_000),
    modified: 'b'.repeat(750_000),
    originalIsBinary: false,
    modifiedIsBinary: false
  })
})

afterEach(() => {
  cleanup()
  prFilesDiffViewStateCache.clear()
  prFilesDiffScrollTopCache.clear()
  vi.clearAllMocks()
})

describe('PR page ownership of Files diff bodies', () => {
  it('keeps loaded rows through Files → Conversation → Files with no new runtime reads', async () => {
    const props = page()
    const view = render(<PullRequestPageTabs {...props} />)
    await loaded(props)
    expect(transport.rpc).toHaveBeenCalledTimes(20)
    expect(transport.rpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'file-lifetime' },
      'github.prFileContents',
      expect.objectContaining({ repo: 'repo', prNumber: 42 }),
      { timeoutMs: 30_000 }
    )

    view.rerender(<PullRequestPageTabs {...props} tab="conversation" />)
    expect(view.container.querySelector('[data-file-loading]')).toBeNull()
    expect(characters(props)).toBe(30_000_000)
    view.rerender(<PullRequestPageTabs {...props} />)
    await loaded(props)
    expect(view.container.querySelector('[data-file-loading="true"]')).toBeNull()
    expect(transport.rpc).toHaveBeenCalledTimes(20)

    view.unmount()
    expect(characters(props)).toBe(0)
    expect(cached(props).loadedIndices).toEqual([])
  })

  it.each(['pr', 'host'] as const)(
    'releases the old %s identity while retaining its replacement',
    async (axis) => {
      const first = page(43, 'runtime:first')
      const second = page(
        axis === 'pr' ? 44 : 43,
        axis === 'host' ? 'runtime:second' : 'runtime:first'
      )
      const view = render(<PullRequestPageTabs {...first} />)
      await loaded(first)
      view.rerender(<PullRequestPageTabs {...first} tab="conversation" />)
      expect(characters(first)).toBe(30_000_000)

      view.rerender(<PullRequestPageTabs {...second} />)
      await loaded(second)
      expect(characters(first)).toBe(0)
      expect(characters(second)).toBe(30_000_000)
      view.rerender(<PullRequestPageTabs {...second} tab="conversation" />)
      expect(characters(second)).toBe(30_000_000)
      view.unmount()
      expect(characters(second)).toBe(0)
    }
  )

  it.each([true, false])(
    'keeps the surviving panel warm when its PR is shared: %s',
    async (shared) => {
      const firstProps = page(shared ? 45 : 46)
      const secondProps = shared ? firstProps : page(47)
      const first = render(<PullRequestPageTabs {...firstProps} />)
      await loaded(firstProps)
      const second = render(<PullRequestPageTabs {...secondProps} />)
      await loaded(secondProps)
      const callsAfterLoads = transport.rpc.mock.calls.length
      first.rerender(<PullRequestPageTabs {...firstProps} tab="conversation" />)
      second.rerender(<PullRequestPageTabs {...secondProps} tab="checks" />)

      first.unmount()
      expect(characters(firstProps)).toBe(shared ? 30_000_000 : 0)
      expect(characters(secondProps)).toBe(30_000_000)
      second.rerender(<PullRequestPageTabs {...secondProps} />)
      await loaded(secondProps)
      expect(transport.rpc).toHaveBeenCalledTimes(callsAfterLoads)
      second.unmount()
      expect(characters(secondProps)).toBe(0)
    }
  )
})
