import {
  repo,
  source,
  key,
  projectKey,
  user,
  seed,
  oldDetails,
  returned,
  table,
  request
} from './github-task-refresh-data.test-fixture'
// @vitest-environment happy-dom
import {
  context,
  store,
  fieldsRenders,
  container,
  taskMutation,
  direct,
  update,
  list,
  projectRead,
  postComment,
  fixture,
  mount,
  click,
  draft
} from './github-task-refresh.test-fixture'

import type * as ProjectViewModule from '@/components/github-project/ProjectViewWrapper'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import { expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import type { Repo } from '../../../shared/repo-types'
import type { GitHubWorkItem, GitHubWorkItemDetails } from '../../../shared/github/work-item-types'
import type { GitHubProjectTable } from '../../../shared/github/project-types'

import { TooltipProvider } from '@/components/ui/tooltip'
import { getTaskPageRepoSourceContext } from '@/components/task-page/task-page-source-context'
import { getTaskSourceCacheScope } from '../../../shared/task-source-context'
import { workItemsCacheKey } from '@/store/github/cache-identity'

import {
  setConfirmedListSnapshot,
  getConfirmedListSnapshot,
  getStickyHideEntry
} from '@/components/task-page/github/task-page-github-work-item-mutation-registry'

import {
  workItemDetailsCache,
  touchWorkItemDetailsCache
} from '@/components/github-item-dialog/load-item-details/work-item-details-cache'

import { createCompatibleRuntimeStatusResponse } from '@/runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '@/runtime/runtime-rpc-client'
import { GITHUB_CANONICAL_DETAILS_RUNTIME_CAPABILITY } from '../../../shared/task-source-runtime-capabilities'

import {
  taskPageGitHubMutationItemId,
  taskPageGitHubItemKey
} from '@/components/task-page/github/task-page-github-work-item-mutation-keys'

import { beginGitHubTaskRead } from '@/store/github/request-coordination'

import { useSmartWorkspaceGithubSearch } from '@/components/new-workspace/use-smart-workspace-github-search'

import { useTaskPageGitHubSearchPagination } from '@/components/task-page/github/use-task-page-github-search-pagination'

it('bounds actual click acceptance and marked completion linearly in existing cached rows and live logical reads', async () => {
  const measurements: {
    n: number
    r: number
    visits: number
    marks: number
    completions: number
  }[] = []
  for (const [n, r] of [
    [100, 1],
    [1000, 1],
    [100, 100],
    [100, 1000]
  ]) {
    fixture(n)
    await mount()
    let visits = 0,
      marks = 0,
      notifications = 0
    const rows = store.getState().workItemsCache[key].data!
    for (const row of rows) {
      const url = row.url
      Object.defineProperty(row, 'url', {
        configurable: true,
        enumerable: true,
        get: () => {
          visits++
          return url
        }
      })
    }
    const reads = Array.from({ length: r }, () =>
      beginGitHubTaskRead([{ repoId: repo.id, sourceContext: source }])
    )
    // Count the production mark calls without replacing publication or cache owners.
    reads.forEach((read) => {
      const mark = read.mark
      vi.spyOn(read, 'mark').mockImplementation((...args) => {
        marks++
        mark(...args)
      })
    })
    const unsubscribe = store.subscribe(() => {
      notifications++
    })
    const beforeCalls = direct.mock.calls.length
    visits = 0
    direct.mockResolvedValue(returned)
    await click()
    const acceptanceVisits = visits
    expect(direct.mock.calls.length - beforeCalls).toBe(1)
    expect(list).not.toHaveBeenCalled()
    expect(marks).toBe(r)
    expect(notifications).toBeLessThanOrEqual(4)
    expect(acceptanceVisits).toBeLessThanOrEqual(16 * (n + 2) + 120)
    visits = 0
    const result = reads[0].apply(rows, store.getState().workItemsCache[key].data!)
    expect(result[0].title).toBe('Accepted title')
    expect(result[1]).toBe(rows[1])
    expect(result.at(-1)).toBe(rows.at(-1))
    const completionVisits = visits
    expect(completionVisits).toBeLessThanOrEqual(4 * (n + 2) + 20)
    measurements.push({ n, r, visits: acceptanceVisits, marks, completions: completionVisits })
    unsubscribe()
    reads.forEach((read) => read.dispose())
    await act(async () => {
      context.root.unmount()
    })
    context.root = createRoot(container)
    workItemDetailsCache.clear()
  }
  expect(measurements[1].visits).toBeLessThanOrEqual(measurements[0].visits * 10 + 120)
  expect(measurements[1].completions).toBeLessThanOrEqual(measurements[0].completions * 10 + 20)
  expect(measurements[3].visits).toBe(measurements[2].visits)
})

it.each([false, true])(
  'preserves old paired opens and only the declared canonical button; paired fork edits keep their inherited route (old=%s)',
  async (old) => {
    const runtimeRepo: Repo = {
      ...repo,
      executionHostId: 'runtime:server',
      issueSourcePreference: 'upstream'
    }
    context.openedItem = { ...seed, repoHostId: 'runtime:server' }
    context.openedSource = getTaskPageRepoSourceContext(runtimeRepo, 'github')!
    const runtimeKey = workItemsCacheKey(
      repo.id,
      30,
      '',
      getTaskSourceCacheScope(context.openedSource)
    )
    const upstream = {
      ...context.openedItem,
      url: 'https://github.com/upstream/r/issues/5',
      title: 'Upstream'
    }
    store.setState({
      repos: [runtimeRepo],
      workItemsCache: { [runtimeKey]: { data: [context.openedItem, upstream], fetchedAt: 10 } }
    })
    const call = vi.fn(
      async ({ method, params }: { method: string; params?: { ownerRepo?: unknown } }) => {
        if (method === 'status.get') {
          const status = createCompatibleRuntimeStatusResponse()
          if (old && status.ok) {
            status.result.capabilities = status.result.capabilities?.filter(
              (cap) => cap !== GITHUB_CANONICAL_DETAILS_RUNTIME_CAPABILITY
            )
          }
          return status
        }
        return {
          id: 'rpc',
          ok: true,
          result:
            method === 'github.workItemDetails'
              ? params?.ownerRepo
                ? returned
                : { ...oldDetails, item: upstream }
              : { ok: true },
          _meta: { runtimeId: 'remote-runtime' }
        }
      }
    )
    Object.assign(window.api, { runtimeEnvironments: { call } })
    await mount()
    expect(container.querySelector('h1')?.textContent).toContain('Upstream')
    const button = container.querySelector<HTMLButtonElement>('[aria-label="Refresh task"]')!
    expect(button.disabled).toBe(old)
    if (old) {
      expect(
        call.mock.calls.filter(([args]) => args.method === 'github.workItemDetails')
      ).toHaveLength(1)
      return
    }
    await click('Add Bob')
    expect(
      call.mock.calls.find(([args]) => args.method === 'github.updateIssue')?.[0].params
    ).not.toHaveProperty('ownerRepo')
    await click()
    expect(container.querySelector('h1')?.textContent).toContain('Accepted title')
    expect(store.getState().workItemsCache[runtimeKey].data?.map((row) => row.title)).toEqual([
      'Accepted title',
      'Upstream'
    ])
    const last = call.mock.calls.findLast(([args]) => args.method === 'github.workItemDetails')?.[0]
    expect(last?.params).toMatchObject({ ownerRepo: { owner: 'o', repo: 'r', host: 'github.com' } })
    expect(list).not.toHaveBeenCalled()
  }
)

it('keeps drafts during acceptance, ignores unrelated store/host updates, and disposes an old-account intent before accepting it', async () => {
  await mount()
  const before = fieldsRenders
  await act(async () =>
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'unrelated' } as AppState['settings']
    })
  ) // SAFETY: this field is the only setting read by the inactive routing branch.
  expect(fieldsRenders).toBe(before)
  await act(async () => {
    const status = createCompatibleRuntimeStatusResponse('another-runtime')
    if (status.ok) {
      store
        .getState()
        .setRuntimeEnvironmentStatus('other-host', { checkedAt: 1, status: status.result })
    }
  })
  expect(fieldsRenders).toBe(before)
  await draft('Body draft', 'Unsaved body')
  await draft('Comment draft', 'Unsaved comment')
  direct.mockResolvedValue(returned)
  await click()
  expect(container.querySelector<HTMLInputElement>('[aria-label="Body draft"]')?.value).toBe(
    'Unsaved body'
  )
  expect(container.querySelector<HTMLInputElement>('[aria-label="Comment draft"]')?.value).toBe(
    'Unsaved comment'
  )
  postComment.mockResolvedValue({
    ok: true,
    comment: {
      id: 10,
      author: 'alice',
      authorAvatarUrl: '',
      body: 'New optimistic comment',
      createdAt: '',
      url: seed.url
    }
  })
  await click('Send comment')
  await click()
  expect(container.querySelector('[data-comments]')?.textContent).toContain(
    'New optimistic comment'
  )
  const obsolete = Promise.withResolvers<GitHubWorkItemDetails | null>()
  direct.mockReturnValueOnce(obsolete.promise)
  await click()
  const bobDetails = { ...returned, item: { ...returned.item, title: 'Bob account' } }
  direct.mockResolvedValue(bobDetails)
  await act(async () =>
    store.setState({ repos: [{ ...repo, ghAccount: { host: 'github.com', user: 'bob' } }] })
  )
  expect(fieldsRenders).toBeGreaterThan(before)
  await act(async () => obsolete.resolve(returned))
  expect(container.querySelector('h1')?.textContent).toContain('Bob account')
  expect(container.querySelector('[role="alert"]')).toBeNull()
  await click()
  expect(container.querySelector('h1')?.textContent).toContain('Bob account')
})

it('updates the real retained Project selection, survives detail eviction, and reconciles its old store writer without changing Project metadata', async () => {
  const { default: Project } = await vi.importActual<typeof ProjectViewModule>(
    '@/components/github-project/ProjectViewWrapper'
  )
  await act(async () =>
    context.root.render(
      <TooltipProvider>
        <Project selectedRepoIds={new Set([repo.id])} sourceHostId="local" />
      </TooltipProvider>
    )
  )
  await click('Open Project task')
  const pending = Promise.withResolvers<{ ok: true; data: GitHubProjectTable }>()
  projectRead.mockReturnValueOnce(pending.promise)
  const reading = store
    .getState()
    .fetchProjectViewTable({ kind: 'local' }, request, { force: true })
  direct.mockResolvedValue(returned)
  await click()
  store
    .getState()
    .patchProjectRowContent(projectKey, 'project-row', { title: 'Newer Project edit' })
  await act(async () => {
    pending.resolve({ ok: true, data: table })
    await reading
  })
  expect(store.getState().projectViewCache[projectKey].data?.rows[0]).toMatchObject({
    position: 7,
    updatedAt: 'project-time',
    content: { title: 'Newer Project edit', assignees: returned.item.assignees }
  })
  workItemDetailsCache.clear()
  await act(async () =>
    context.root.render(
      <TooltipProvider>
        <Project selectedRepoIds={new Set([repo.id])} sourceHostId="local" />
      </TooltipProvider>
    )
  )
  expect(container.querySelector('h1')?.textContent).toContain('Accepted title')
})

it('retires only captured contradictions through actual Tasks settlement and preserves equal/newer masks without a retry loop', async () => {
  await mount()
  await act(async () => {
    await taskMutation.run({
      item: seed,
      sourceContext: source,
      intent: { type: 'setState', state: 'closed' },
      mutate: update,
      errorToast: 'Rejected'
    })
  })
  const itemKey = taskPageGitHubItemKey(seed.repoId, seed.id)
  expect(getStickyHideEntry(itemKey)).toBeDefined()
  const scope = getTaskSourceCacheScope(source),
    id = taskPageGitHubMutationItemId(seed)
  setConfirmedListSnapshot(scope, repo.id, id, 'assignees', [user('old')])
  direct.mockResolvedValue(returned)
  await click()
  expect(getStickyHideEntry(itemKey)).toBeUndefined()
  expect(getConfirmedListSnapshot(scope, repo.id, id, 'assignees')).toBeUndefined()
  setConfirmedListSnapshot(scope, repo.id, id, 'assignees', returned.item.assignees!)
  const pending = Promise.withResolvers<GitHubWorkItemDetails | null>()
  direct.mockReturnValueOnce(pending.promise)
  await click()
  setConfirmedListSnapshot(scope, repo.id, id, 'assignees', returned.item.assignees!)
  const newer = getConfirmedListSnapshot(scope, repo.id, id, 'assignees')
  await act(async () => pending.resolve(returned))
  expect(getConfirmedListSnapshot(scope, repo.id, id, 'assignees')).toBe(newer)
  const contradiction = Promise.withResolvers<GitHubWorkItemDetails | null>()
  direct.mockReturnValueOnce(contradiction.promise)
  await click()
  setConfirmedListSnapshot(scope, repo.id, id, 'assignees', [user('new owner')])
  const calls = direct.mock.calls.length
  await act(async () => contradiction.resolve(returned))
  expect(direct).toHaveBeenCalledTimes(calls)
  expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1)
  expect(getConfirmedListSnapshot(scope, repo.id, id, 'assignees')?.[0].login).toBe('new owner')
})

it('keeps page-N navigation and a shared workspace raw callback through acceptance and a later edit', async () => {
  await mount()
  const gate = Promise.withResolvers<unknown>()
  list.mockReturnValue(gate.promise)
  let destination = -1,
    loading = true,
    sharedItems: GitHubWorkItem[] = []
  const pagesRef = { current: context.pages },
    noop = () => {}
  const foundation = {
    debouncedQuery: '',
    disabled: false,
    handledCrossRepoUrlRef: { current: '' },
    repoSlugCacheRef: { current: new Map() },
    repoBackedSearchTargets: [{ repo, githubSourceContext: source }],
    repos: [repo],
    ...store.getState(),
    setGithubItems: (change: GitHubWorkItem[] | ((rows: GitHubWorkItem[]) => GitHubWorkItem[])) => {
      sharedItems = typeof change === 'function' ? change(sharedItems) : change
    },
    setGithubLoading: noop,
    setCrossRepoPrompt: noop
  }
  function Consumers() {
    useSmartWorkspaceGithubSearch({
      foundation: foundation as Parameters<typeof useSmartWorkspaceGithubSearch>[0]['foundation'],
      sourceQueryWithinLimit: true,
      shouldQueryGithub: true
    }) // SAFETY: only list branch fields are consumed.
    const model = useTaskPageGitHubSearchPagination({
      selectedRepos: [repo],
      currentPage: 0,
      appliedTaskSearch: '',
      paginationLoading: false,
      githubPerRepoPageLimit: 30,
      githubPageSize: 30,
      ...store.getState(),
      pagesRef,
      currentPageRef: { current: 0 },
      paginationGenerationRef: { current: 1 },
      countedTotalPagesRef: { current: null },
      setPaginationLoading: (v: boolean) => {
        loading = v
      },
      setLoadingTargetPage: noop,
      setCurrentPage: (v: number) => {
        destination = v
      },
      setPages: (change: (p: typeof context.pages) => typeof context.pages) => {
        context.pages = change(context.pages)
        pagesRef.current = context.pages
      },
      taskResumeApplied: false
    } as Parameters<typeof useTaskPageGitHubSearchPagination>[0]) // SAFETY: complete page-click/list state; query persistence inactive.
    return <button onClick={() => void model.handleLoadNextPage(4)}>Load page five</button>
  }
  const node = document.createElement('div'),
    consumer = createRoot(node)
  await act(async () => consumer.render(<Consumers />))
  await act(async () => node.querySelector('button')!.click())
  direct.mockResolvedValue(returned)
  await click()
  sharedItems = [{ ...seed, title: 'New shared edit' }]
  pagesRef.current = context.pages
  await act(async () => gate.resolve({ items: [seed], sources: { issues: null, prs: null } }))
  expect(destination).toBe(4)
  expect(loading).toBe(false)
  expect(context.pages[4]?.[0].title).toBe('Accepted title')
  expect(sharedItems[0].title).toBe('New shared edit')
  await act(async () => consumer.unmount())
})

it.each(['read', 'capability'])(
  'disposes same-ID runtime attempts during %s on actual incarnation change, preserves continuity, and sends a fresh click to the new runtime',
  async (stage) => {
    const runtimeRepo: Repo = { ...repo, executionHostId: 'runtime:server' }
    context.openedItem = { ...seed, repoHostId: 'runtime:server' }
    context.openedSource = getTaskPageRepoSourceContext(runtimeRepo, 'github')!
    store.setState({ repos: [runtimeRepo] })
    const firstStatus = createCompatibleRuntimeStatusResponse('runtime-one')
    if (!firstStatus.ok) {
      throw new Error('fixture')
    }
    store
      .getState()
      .setRuntimeEnvironmentStatus('server', { status: firstStatus.result, checkedAt: 1 })
    const pending = Promise.withResolvers<unknown>()
    let runtimeId = 'runtime-one',
      hold = false
    const call = vi.fn(async ({ method }: { method: string }) =>
      method === 'status.get'
        ? hold && stage === 'capability'
          ? pending.promise
          : createCompatibleRuntimeStatusResponse(runtimeId)
        : hold
          ? pending.promise
          : { id: 'rpc', ok: true, result: returned, _meta: { runtimeId } }
    )
    Object.assign(window.api, { runtimeEnvironments: { call } })
    await mount()
    hold = true
    if (stage === 'capability') {
      clearRuntimeCompatibilityCacheForTests()
    }
    await click()
    const before = fieldsRenders
    await act(async () =>
      store
        .getState()
        .setRuntimeEnvironmentStatus('server', { status: firstStatus.result, checkedAt: 2 })
    )
    expect(fieldsRenders).toBe(before)
    runtimeId = 'runtime-two'
    hold = false
    const nextStatus = createCompatibleRuntimeStatusResponse(runtimeId)
    if (!nextStatus.ok) {
      throw new Error('fixture')
    }
    await act(async () =>
      store
        .getState()
        .setRuntimeEnvironmentStatus('server', { status: nextStatus.result, checkedAt: 3 })
    )
    await act(async () =>
      pending.resolve(
        stage === 'capability'
          ? createCompatibleRuntimeStatusResponse('runtime-one')
          : {
              id: 'old',
              ok: true,
              result: { ...returned, item: { ...returned.item, title: 'Obsolete runtime' } },
              _meta: { runtimeId: 'runtime-one' }
            }
      )
    )
    expect(container.querySelector('h1')?.textContent).not.toContain('Obsolete runtime')
    await click()
    expect(container.querySelector('h1')?.textContent).toContain('Accepted title')
  }
)

it('reconciles displaced weak/force/stronger raw returns and store commits with the current qualified twin owner', async () => {
  await mount()
  const weak = Promise.withResolvers<unknown>(),
    forced = Promise.withResolvers<unknown>(),
    strict = Promise.withResolvers<unknown>()
  list
    .mockReturnValueOnce(weak.promise)
    .mockReturnValueOnce(forced.promise)
    .mockReturnValueOnce(strict.promise)
  const fetch = store.getState().fetchWorkItems
  const r0 = fetch(repo.id, repo.path, 30, '', { sourceContext: source, force: false })
  const r1 = fetch(repo.id, repo.path, 30, '', { sourceContext: source, force: true })
  const r2 = fetch(repo.id, repo.path, 30, '', {
    sourceContext: source,
    force: true,
    noCache: true
  })
  await act(async () => {
    weak.resolve({ items: [seed], sources: { issues: null, prs: null } })
    await r0
  })
  expect(list).toHaveBeenCalledTimes(3)
  direct.mockResolvedValue(returned)
  await click()
  store.setState((state) => ({
    workItemsCache: {
      ...state.workItemsCache,
      [key]: {
        ...state.workItemsCache[key],
        data: [
          { ...seed, title: 'Newer target' },
          { ...seed, repoId: 'registered-twin', title: 'Wrong current twin' }
        ]
      }
    }
  }))
  let oldRows: GitHubWorkItem[] = [],
    strictRows: GitHubWorkItem[] = []
  await act(async () => {
    forced.resolve({ items: [seed], sources: { issues: null, prs: null } })
    oldRows = await r1
  })
  await act(async () => {
    strict.resolve({ items: [seed], sources: { issues: null, prs: null } })
    strictRows = await r2
  })
  expect(oldRows[0].title).toBe('Newer target')
  expect(strictRows[0].title).toBe('Newer target')
  expect(store.getState().workItemsCache[key].data?.[0].title).toBe('Newer target')
})

it('keeps an ordinary pending lease through an earlier dialog comment callback and an unrelated accepted Refresh', async () => {
  await mount()
  const rb = Promise.withResolvers<GitHubWorkItemDetails | null>(),
    post = Promise.withResolvers<unknown>()
  const [bKey, bEntry] = [...workItemDetailsCache.entries()][0]
  direct.mockReturnValueOnce(rb.promise)
  await act(async () => touchWorkItemDetailsCache(bKey, { ...bEntry, fetchedAt: 0 }))
  const bPending = workItemDetailsCache.get(bKey)?.pending
  expect(bPending).toBeDefined()
  postComment.mockReturnValueOnce(post.promise)
  await draft('Comment draft', 'Reply while loading')
  await click('Send comment')
  context.openedItem = { ...seed, id: 'issue:6', number: 6, url: 'https://github.com/o/r/issues/6' }
  const a = {
    ...returned,
    item: { ...returned.item, number: 6, url: context.openedItem.url, title: 'Task A' }
  }
  direct.mockResolvedValue(a)
  await mount()
  await act(async () =>
    post.resolve({
      ok: true,
      comment: {
        id: 11,
        author: 'alice',
        authorAvatarUrl: '',
        body: 'B comment',
        createdAt: '',
        url: seed.url
      }
    })
  )
  expect(workItemDetailsCache.get(bKey)?.pending).toBe(bPending)
  await click()
  await act(async () =>
    rb.resolve({ ...oldDetails, item: { ...oldDetails.item, title: 'Useful later B title' } })
  )
  expect(workItemDetailsCache.get(bKey)?.details?.item.title).toBe('Useful later B title')
  expect(workItemDetailsCache.get(bKey)?.pending).toBeUndefined()
  expect(container.querySelector('h1')?.textContent).toContain('Task A')
})
