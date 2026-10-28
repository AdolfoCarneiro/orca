import {
  repo,
  source,
  key,
  projectKey,
  user,
  seed,
  returned,
  projectRow,
  table,
  resume
} from './github-task-refresh-data.test-fixture'
// @vitest-environment happy-dom
import {
  context,
  useItem,
  store,
  container,
  taskMutation,
  harnessSetPages,
  direct,
  update,
  list,
  issueType,
  fixture,
  mount,
  click,
  draft
} from './github-task-refresh.test-fixture'

import React, { act } from 'react'

import { expect, it } from 'vitest'

import type { GitHubWorkItemDetails } from '../../../shared/github/work-item-types'

import { getTaskSourceCacheScope } from '../../../shared/task-source-context'
import { workItemsCacheKey, projectViewCacheKey } from '@/store/github/cache-identity'

import { taskPageGitHubResumeCache } from '@/components/task-page/github/task-page-github-resume-cache'

import { buildProjectWorkItem } from '@/components/github-project/project-work-item'
import { buildTaskSourceContextFromRepo } from '../../../shared/task-source-context'

import { runTaskPageGitHubQuietRefresh } from '@/components/task-page/github/task-page-github-quiet-refresh-run'
import type { TaskPageGitHubQuietRefreshPreludeModel } from '@/components/task-page/github/use-task-page-github-quiet-refresh'

import { runTaskPageGitHubLandingRefresh } from '@/components/task-page/github/task-page-github-landing-refresh-run'
import type { TaskPageGitHubSearchPaginationModel } from '@/components/task-page/github/use-task-page-github-search-pagination'

it('clicks the real header/direct reader/settler and publishes accepted data to URL aliases, page-N, resume, drawer and two Project views', async () => {
  const { twin } = fixture()
  const foreignSource = { ...source, projectId: 'different-registered-account' }
  const foreignKey = workItemsCacheKey(repo.id, 30, '', getTaskSourceCacheScope(foreignSource))
  const remoteProjectKey = projectViewCacheKey(
    'organization',
    'o',
    1,
    'view',
    undefined,
    'runtime:other'
  )
  const foreign = { data: [seed], fetchedAt: 11 },
    remoteProject = { data: table, fetchedAt: 12 }
  store.setState((state) => ({
    workItemsCache: { ...state.workItemsCache, [foreignKey]: foreign },
    projectViewCache: { ...state.projectViewCache, [remoteProjectKey]: remoteProject }
  }))
  context.openedItem = buildProjectWorkItem(
    { ...projectRow, content: { ...projectRow.content, assignees: [user('alice')] } },
    repo
  )!
  context.openedSource = buildTaskSourceContextFromRepo({
    provider: 'github',
    projectId: repo.id,
    repo
  })!
  expect(context.openedItem.assignees).toBeUndefined()
  taskPageGitHubResumeCache.write(resume, 2, context.pages[2]!, Date.now())
  const before = taskPageGitHubResumeCache.read(resume, 2)!.cachedAt
  await mount()
  expect(direct).toHaveBeenCalledTimes(1)
  await click('Add Bob')
  expect(store.getState().workItemsCache[key].data?.[0].assignees).toBeUndefined() // no automatic delta-derived publication
  const beforeRefresh = direct.mock.calls.length
  direct.mockResolvedValue(returned)
  await click()
  expect(direct).toHaveBeenCalledTimes(beforeRefresh + 1)
  expect(list).not.toHaveBeenCalled()
  expect(direct.mock.calls.at(-1)?.[0]).toMatchObject({
    repoId: repo.id,
    sourceContext: context.openedSource,
    ownerRepo: { owner: 'o', repo: 'r', host: 'github.com' }
  })
  expect(container.querySelector('h1')?.textContent).toContain('Accepted title')
  expect(container.querySelector('[data-assignees]')?.textContent).toBe('alice,bob')
  expect(container.querySelector('[data-body]')?.textContent).toBe('Accepted body')
  expect(context.pages[2]?.[0]).toMatchObject({
    id: 'issue:5',
    title: 'Accepted title',
    assignees: returned.item.assignees
  })
  expect(context.pages[2]?.[1]).toBe(twin)
  expect(store.getState().workItemsCache[key].data?.[0]).toMatchObject({
    id: 'issue:5',
    title: 'Accepted title',
    repoHostId: 'local'
  })
  expect(store.getState().githubTaskDrawerWorkItem).toMatchObject({
    id: seed.id,
    title: 'Accepted title'
  })
  expect(taskPageGitHubResumeCache.read(resume, 2)?.cachedAt).toBe(before)
  expect(taskPageGitHubResumeCache.read(resume, 2)?.items[0].title).toBe('Accepted title')
  for (const entry of Object.values(store.getState().projectViewCache).filter(
    (entry) => entry !== remoteProject
  )) {
    expect(entry).toMatchObject({
      data: {
        rows: [
          {
            id: 'project-row',
            content: {
              title: 'Accepted title',
              body: 'Accepted body',
              assignees: returned.item.assignees
            }
          }
        ]
      }
    })
  }
  expect(store.getState().workItemsCache[foreignKey]).toBe(foreign)
  expect(store.getState().projectViewCache[remoteProjectKey]).toBe(remoteProject)
  expect(store.getState().projectViewCache[projectKey].data?.rows[0].fieldValuesByFieldId).toBe(
    projectRow.fieldValuesByFieldId
  )
  await click('Start workspace from issue')
  expect(useItem).toHaveBeenLastCalledWith(
    expect.objectContaining({ id: context.openedItem.id, title: 'Accepted title' })
  )
})

it.each(['immediate', 'tasks', 'body', 'project'])(
  'keeps the finite intent alive across a real %s failure/rollback and retries only after its final callback',
  async (writer) => {
    await mount()
    const first = Promise.withResolvers<GitHubWorkItemDetails | null>(),
      write = Promise.withResolvers<{ ok: boolean; error?: string }>()
    direct.mockReturnValueOnce(first.promise).mockResolvedValue(returned)
    await click()
    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="Refresh task"]')?.disabled
    ).toBe(true)
    update.mockReturnValueOnce(write.promise)
    let writing: Promise<unknown> | undefined
    if (writer === 'immediate') {
      await click('Add Bob')
    }
    if (writer === 'tasks') {
      await act(async () => {
        writing = taskMutation.run({
          item: seed,
          sourceContext: source,
          intent: { type: 'toggleAssignee', user: user('bob') },
          mutate: update,
          errorToast: 'Rejected'
        })
      })
    }
    if (writer === 'body') {
      await draft('Body draft', 'Write body')
      await click('Save body')
    }
    if (writer === 'project') {
      await act(async () => {
        writing = store
          .getState()
          .patchProjectIssueOrPr(projectKey, 'project-row', { title: 'Write title' })
      })
    }
    await act(async () => first.resolve(returned))
    expect(direct).toHaveBeenCalledTimes(2)
    await act(async () => {
      write.resolve({ ok: false, error: 'Rejected edit' })
      await writing
    })
    expect(direct).toHaveBeenCalledTimes(3)
    expect(container.querySelector('[data-assignees]')?.textContent).toBe('alice,bob')
    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="Refresh task"]')?.disabled
    ).toBe(false)
    expect(container.querySelector('[role="alert"]')).toBeNull()
  }
)

it('waits for a pre-open Project Issue Type whole-row rollback, then accepts true empty membership; failure retains visible content and permits retry', async () => {
  const pending = Promise.withResolvers<{ ok: boolean; error: { type: string; message: string } }>()
  issueType.mockReturnValueOnce(pending.promise)
  const writing = store.getState().patchProjectRowIssueType(projectKey, 'project-row', {
    id: 'bug',
    name: 'Bug',
    color: null,
    description: null
  })
  await mount()
  direct.mockResolvedValue({ ...returned, item: { ...returned.item, assignees: [] } })
  await click()
  expect(direct).toHaveBeenCalledTimes(1)
  await act(async () => {
    pending.resolve({ ok: false, error: { type: 'unknown', message: 'Rejected type' } })
    await writing
  })
  expect(direct).toHaveBeenCalledTimes(2)
  expect(store.getState().projectViewCache[projectKey].data?.rows[0].content).toMatchObject({
    title: 'Accepted title',
    assignees: []
  })
  direct.mockResolvedValueOnce({
    ...returned,
    item: { ...returned.item, url: 'https://github.com/o/r/issues/6' }
  })
  await click()
  expect(container.querySelector('h1')?.textContent).toContain('Accepted title')
  expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1)
  direct.mockResolvedValue(returned)
  await click()
  expect(container.querySelector('[role="alert"]')).toBeNull()
})

it('reconciles a real aggregate held leaf at landing final commit against a newer ordinary edit, then allows a later ordinary read', async () => {
  await mount()
  const otherRepo = { ...repo, id: 'other', path: '/other' },
    gate = Promise.withResolvers<unknown>()
  store.setState({ repos: [repo, otherRepo] })
  list.mockImplementation((args: { repoId: string }) =>
    args.repoId === 'other'
      ? gate.promise
      : Promise.resolve({
          items: [{ ...seed, id: 'issue:5', title: 'Old list' }],
          sources: { issues: null, prs: null }
        })
  )
  const pagesRef = { current: context.pages },
    nonce = { current: 0 }
  const setPages = (
    change: typeof context.pages | ((p: typeof context.pages) => typeof context.pages)
  ) => {
    harnessSetPages((current) => {
      const next = typeof change === 'function' ? change(current) : change
      pagesRef.current = next
      return next
    })
  }
  const noop = () => {}
  const model = {
    ...store.getState(),
    selectedRepos: [repo, otherRepo],
    taskSource: 'github',
    taskResumeApplied: true,
    githubMode: 'items',
    appliedTaskSearch: '',
    taskRefreshNonce: 1,
    lastFetchedNonceRef: { current: 0 },
    lastFetchedInvalidationNonceRef: { current: 0 },
    paginationGenerationRef: nonce,
    landingGitHubRefreshKeysRef: { current: new Set() },
    githubPerRepoPageLimit: 30,
    githubPageSize: 30,
    githubResumeContextKey: resume,
    setPages,
    pagesRef,
    currentPageRef: { current: 0 },
    githubResumeConsumedRef: { current: true },
    githubResumeContextRef: { current: resume },
    pendingGithubScrollRestoreRef: { current: 0 },
    countedTotalPagesRef: { current: null },
    hardRefreshEpochRef: { current: 0 },
    retryingSourceKeys: new Set(),
    setRetryingSourceKeys: noop,
    githubWorkItemMutationQueryKey: 'q',
    setTasksLoading: noop,
    setTasksRefreshing: noop,
    setTasksFiltering: noop,
    setTasksError: noop,
    setFailedCount: noop,
    setGithubUnavailable: noop,
    setCurrentPage: noop,
    setPaginationLoading: noop,
    setLoadingTargetPage: noop,
    setCountedTotalPages: noop,
    setProvenPageLimit: noop
  }
  let cleanup: (() => void) | undefined
  await act(async () => {
    cleanup = runTaskPageGitHubLandingRefresh(model as TaskPageGitHubSearchPaginationModel)
  }) // SAFETY: supplied fields cover this production runner's complete path.
  direct.mockResolvedValue(returned)
  await click()
  await act(async () =>
    harnessSetPages((current) =>
      current.map(
        (page) =>
          page?.map((row) => (row.url === seed.url ? { ...row, title: 'Newer edit' } : row)) ?? null
      )
    )
  )
  pagesRef.current = context.pages
  await act(async () => gate.resolve({ items: [], sources: { issues: null, prs: null } }))
  expect(
    context.pages.flatMap((page) => page ?? []).find((row) => row.url === seed.url)?.title
  ).toBe('Newer edit')
  cleanup?.()
  list.mockResolvedValue({
    items: [{ ...seed, title: 'Later ordinary' }],
    sources: { issues: null, prs: null }
  })
  await act(async () => {
    await store
      .getState()
      .fetchWorkItems(repo.id, repo.path, 30, '', { force: true, sourceContext: source })
  })
  expect(store.getState().workItemsCache[key].data?.[0].title).toBe('Later ordinary')
  await act(async () =>
    taskMutation.run({
      item: seed,
      sourceContext: source,
      intent: { type: 'toggleAssignee', user: user('bob') },
      mutate: update,
      errorToast: 'Rejected'
    })
  )
  const authority = Promise.withResolvers<unknown>(),
    visible = Promise.withResolvers<unknown>()
  list.mockReturnValueOnce(authority.promise).mockReturnValueOnce(visible.promise)
  const owner = {},
    currentPageRef = { current: 0 }
  const quietCleanup = runTaskPageGitHubQuietRefresh({
    ...model,
    selectedRepos: [repo],
    pages: context.pages,
    currentPage: 0,
    currentPageRef,
    quietRefreshNonce: 1,
    setQuietRefreshNonce: noop,
    quietRevalidateMountedRef: { current: true },
    quietRevalidateOwnerRef: { current: owner },
    quietRevalidateScopeRef: { current: { queryKey: 'q', generation: 1 } }
  } as TaskPageGitHubQuietRefreshPreludeModel) // SAFETY: complete runner state with actual slice fetch actions.
  currentPageRef.current = 2
  await act(async () => authority.resolve({ items: [seed], sources: { issues: null, prs: null } }))
  direct.mockResolvedValue({ ...returned, item: { ...returned.item, title: 'Second accepted' } })
  await click()
  await act(async () =>
    harnessSetPages((current) =>
      current.map(
        (page) =>
          page?.map((row) =>
            row.url === seed.url ? { ...row, title: 'After second acceptance' } : row
          ) ?? null
      )
    )
  )
  pagesRef.current = context.pages
  await act(async () => visible.resolve({ items: [seed], sources: { issues: null, prs: null } }))
  expect(context.pages[0]?.find((row) => row.url === seed.url)?.title).toBe(
    'After second acceptance'
  )
  quietCleanup?.()
})
