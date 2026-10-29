import './github-task-refresh.test-fixture'
import { runTaskPageGitHubQuietRefresh } from '@/components/task-page/github/task-page-github-quiet-refresh-run'
import { runTaskPageGitHubLandingRefresh } from '@/components/task-page/github/task-page-github-landing-refresh-run'
import { getTaskPageGitHubMutationQueryKey } from '@/components/task-page/github/task-page-github-work-item-mutation-registry'
import { parseTaskQuery } from '../../../shared/task-query'
// @vitest-environment happy-dom
import {
  context,
  store,
  mount,
  click,
  direct,
  update,
  list,
  taskMutation,
  harnessSetPages,
  container
} from './github-task-refresh.test-fixture'
import {
  repo,
  source,
  seed,
  key,
  projectKey,
  projectRow,
  table,
  returned,
  user
} from './github-task-refresh-data.test-fixture'
import React, { act } from 'react'
import { expect, it, vi } from 'vitest'

import * as i18n from '@/i18n/i18n'

import { projectViewCacheKey } from '@/store/github/cache-identity'
import type { GitHubWorkItem } from '../../../shared/github/work-item-types'
import type { useTaskPageGitHubWorkItemMutation } from '@/hooks/useTaskPageGitHubWorkItemMutation'

it('shows accepted ordinary pages and Project assignees through real row/chip/card readers, rollback and assignee-filter exits without changing twins', async () => {
  const actualI18n = await vi.importActual<typeof i18n>('@/i18n/i18n')
  vi.spyOn(i18n, 'translate').mockImplementation(actualI18n.translate)
  const local = { ...seed, id: 'issue:5', assignees: [user('alice')] }
  const upstream = {
    ...local,
    id: 'issue:5',
    title: 'Upstream twin',
    url: 'https://github.com/upstream/r/issues/5',
    assignees: [user('bob'), user('cora')]
  }
  const host = {
    ...local,
    title: 'Host twin',
    repoHostId: 'ssh:builder' as const,
    assignees: [user('bob'), user('dora')]
  }
  const ghes = {
    ...local,
    title: 'Enterprise twin',
    url: 'https://git.example.com/o/r/issues/5',
    assignees: [user('bob'), user('erin')]
  }
  const independentlyHidden = {
    ...host,
    id: 'issue:6',
    number: 6,
    url: 'https://github.com/o/r/issues/6',
    title: 'Independent host exit',
    assignees: [user('bob')]
  }
  const unassociated = {
    ...local,
    repoHostId: undefined,
    title: 'Ambiguous old row',
    assignees: [user('bob')]
  }
  const row = { ...projectRow, content: { ...projectRow.content, assignees: local.assignees } }
  const upstreamRow = {
    ...row,
    id: 'upstream',
    content: { ...row.content, url: upstream.url, assignees: upstream.assignees }
  }
  const remoteKey = projectViewCacheKey('organization', 'o', 1, 'view', undefined, 'runtime:other')
  store.setState({
    repos: [
      repo,
      { ...repo, path: '/remote/repo', executionHostId: 'ssh:builder', connectionId: 'builder' }
    ],
    workItemsCache: {
      [key]: {
        data: [local, upstream, host, ghes, independentlyHidden, unassociated],
        fetchedAt: 10
      }
    },
    projectViewCache: {
      [projectKey]: { data: { ...table, rows: [row, upstreamRow] }, fetchedAt: 20 },
      [remoteKey]: {
        data: {
          ...table,
          rows: [{ ...row, content: { ...row.content, assignees: host.assignees } }]
        },
        fetchedAt: 30
      }
    }
  })
  context.pages = [null, null, [local, upstream, host, ghes, independentlyHidden, unassociated]]
  const outputs = (
    pages: (GitHubWorkItem[] | null)[],
    mutation: ReturnType<typeof useTaskPageGitHubWorkItemMutation>,
    queryKey: string,
    viewerLogin: string | null
  ) => (
    <VisibleReaders
      pages={pages}
      mutation={mutation}
      queryKey={queryKey}
      viewerLogin={viewerLogin}
    />
  )
  await mount(false, outputs, 'is:open assignee:bob', true)
  await act(async () => {
    await taskMutation.run({
      item: independentlyHidden,
      sourceContext: getTaskPageRepoSourceContext(store.getState().repos[1], 'github'),
      intent: { type: 'toggleAssignee', user: user('bob') },
      mutate: async () => ({ ok: true }),
      errorToast: 'Rejected'
    })
  })
  const hiddenControl = context.pages[2]![4]
  const task = (title: string) =>
    [...container.querySelectorAll('[data-tasks] h3')]
      .find((node) => node.textContent === title)
      ?.closest('[role="button"]')
  const projects = () => [...container.querySelectorAll('[data-project-output]')]
  const targetProject = () =>
    projects().find(
      (node) => node.getAttribute('data-project-output') === `${projectKey}:${projectRow.id}`
    )!
  const assertProject = (logins: string[]) => {
    for (const selector of ['[data-list-chips]', '[role="listitem"]']) {
      expect(
        [...targetProject().querySelectorAll(`${selector} img`)].map((img) =>
          img.getAttribute('alt')
        )
      ).toEqual(logins)
    }
  }
  const controls = [
    task(upstream.title)!.innerHTML,
    task(host.title)!.innerHTML,
    task(ghes.title)!.innerHTML,
    task(unassociated.title)!.innerHTML,
    ...projects()
      .filter((node) => node !== targetProject())
      .map((node) => node.innerHTML)
  ]
  const assertTwins = () => {
    expect(
      task(unassociated.title),
      'an ambiguous old observation stays ordinarily visible'
    ).toBeTruthy()
    expect(task(independentlyHidden.title)).toBeUndefined()
    expect(context.pages[2]?.[4]).toBe(hiddenControl)
    expect(task(host.title), 'the other registered host must remain visible').toBeTruthy()
    expect([
      task(upstream.title)!.innerHTML,
      task(host.title)!.innerHTML,
      task(ghes.title)!.innerHTML,
      task(unassociated.title)!.innerHTML,
      ...projects()
        .filter((node) => node !== targetProject())
        .map((node) => node.innerHTML)
    ]).toEqual(controls)
    expect(context.pages[2]?.slice(1)).toEqual([upstream, host, ghes, hiddenControl, unassociated])
  }
  expect(task(seed.title)?.querySelector('[aria-label="Assigned to alice"]')).not.toBeNull()
  assertProject(['alice'])
  await click('Add Bob')
  expect(task(seed.title)?.querySelector('[aria-label="Assigned to alice"]')).not.toBeNull()
  direct.mockResolvedValue(returned)
  await click()
  const acceptedTask = task(returned.item.title)!
  expect(acceptedTask.querySelector('[aria-label="Assigned to alice, bob"]')).not.toBeNull()
  expect(
    [...acceptedTask.querySelectorAll('img')].map((img) => [
      img.getAttribute('src'),
      img.getAttribute('title')
    ])
  ).toEqual([
    ['alice.png', 'alice (alice)'],
    ['bob.png', 'bob (bob)']
  ])
  assertProject(['alice', 'bob'])
  assertTwins()
  const rejected = Promise.withResolvers<{
    ok: false
    error: { type: 'unknown'; message: string }
  }>()
  update.mockReturnValueOnce(rejected.promise)
  let writing: Promise<unknown> | undefined
  await act(async () => {
    writing = store
      .getState()
      .patchProjectIssueOrPr(projectKey, projectRow.id, { removeAssignees: ['bob'] })
  })
  assertProject(['alice'])
  assertTwins()
  await act(async () => {
    rejected.resolve({ ok: false, error: { type: 'unknown', message: 'Rejected edit' } })
    await writing
  })
  assertProject(['alice', 'bob'])
  expect(
    task(returned.item.title)?.querySelector('[aria-label="Assigned to alice, bob"]')
  ).not.toBeNull()
  assertTwins()
  direct.mockResolvedValue({ ...returned, item: { ...returned.item, assignees: [user('alice')] } })
  await click()
  expect(task(returned.item.title)).toBeUndefined()
  expect(context.pages[2]?.[0].assignees).toEqual([user('alice')])
  assertProject(['alice'])
  assertTwins()
  direct.mockResolvedValue(returned)
  await click()
  expect(
    task(returned.item.title)?.querySelector('[aria-label="Assigned to alice, bob"]')
  ).not.toBeNull()
  assertTwins()
  await act(async () => {
    await taskMutation.run({
      item: context.pages[2]![0],
      sourceContext: source,
      intent: { type: 'toggleAssignee', user: user('cora') },
      mutate: async () => ({ ok: true }),
      errorToast: 'Rejected'
    })
  })
  assertTwins()
  await act(async () => {
    await taskMutation.run({
      item: unassociated,
      sourceContext: getTaskPageRepoSourceContext(store.getState().repos[1], 'github'),
      intent: { type: 'toggleAssignee', user: user('zoe') },
      mutate: async () => ({ ok: true }),
      errorToast: 'Rejected'
    })
  })
  expect(
    task(unassociated.title)?.querySelector('[aria-label="Assigned to bob, zoe"]')
  ).not.toBeNull()
  expect(
    task(returned.item.title)?.querySelector('[aria-label="Assigned to alice, bob, cora"]')
  ).not.toBeNull()
})

import { assertTaskPageGitHubDialogStateAuthority } from '@/components/task-page/github/task-page-github-dialog-state-authority'
import { getTaskPageRepoSourceContext } from '@/lib/task-repo-source-context'
import { getTaskSourceCacheScope } from '../../../shared/task-source-context'

import { getLastConfirmedClientEntry } from '@/components/task-page/github/task-page-github-confirmed-client-values'

it('keeps independently exited page-N rows through real partial/quiet admission, then restores numbered pages and adopts ordinary reentry on forced landing', async () => {
  let query = 'is:open assignee:bob'
  const remote = {
    ...repo,
    executionHostId: 'ssh:builder' as const,
    connectionId: 'builder',
    path: '/remote'
  }
  const remoteSource = getTaskPageRepoSourceContext(remote, 'github')!
  const local = { ...seed, id: 'issue:5', assignees: [user('bob')] }
  const foreign = { ...local, repoHostId: 'ssh:builder' as const, title: 'Foreign retained exit' }
  store.setState({ repos: [repo, remote] })
  context.pages = [[local], null, [foreign]]
  const outputs = (
    pages: (GitHubWorkItem[] | null)[],
    mutation: ReturnType<typeof useTaskPageGitHubWorkItemMutation>,
    key: string,
    viewerLogin: string | null
  ) => (
    <VisibleReaders
      pages={pages}
      mutation={mutation}
      queryKey={key}
      viewerLogin={viewerLogin}
      query={query}
    />
  )
  await mount(false, outputs, query, true)
  direct.mockResolvedValue({ ...returned, item: { ...returned.item, assignees: [user('alice')] } })
  await click()
  context.openedItem = foreign
  context.openedSource = remoteSource
  await mount(false, outputs, query, true)
  direct.mockResolvedValue({
    ...returned,
    item: { ...returned.item, assignees: [user('alice')], title: foreign.title }
  })
  await click()
  const visible = () =>
    [...container.querySelectorAll('[data-tasks] h3')].map((node) => node.textContent)
  expect(visible()).toEqual([])
  const foreignRow = context.pages[2]![0]
  const queryKey = getTaskPageGitHubMutationQueryKey()!
  await act(async () =>
    assertTaskPageGitHubDialogStateAuthority({
      repoId: repo.id,
      itemId: local.id,
      sourceContext: source,
      state: 'closed',
      ownerRepo: { owner: 'o', repo: 'r' }
    })
  )
  const pagesRef = { current: context.pages },
    currentPageRef = { current: 0 },
    hardRefreshEpochRef = { current: 0 }
  const mounted = { current: true },
    noop = () => {}
  const setPages = (
    change: typeof context.pages | ((previous: typeof context.pages) => typeof context.pages)
  ) =>
    harnessSetPages((previous) => {
      const next = typeof change === 'function' ? change(previous) : change
      pagesRef.current = next
      return next
    })
  const model = {
    ...store.getState(),
    selectedRepos: [repo, remote],
    taskSource: 'github',
    githubMode: 'items',
    appliedTaskSearch: query,
    appliedTaskQuery: parseTaskQuery(query),
    githubViewerLogin: 'alice',
    githubWorkItemMutationQueryKey: queryKey,
    selectedReposKey: 'registered',
    quietRefreshNonce: 1,
    setQuietRefreshNonce: noop,
    githubPerRepoPageLimit: 30,
    githubPageSize: 30,
    pages: context.pages,
    pagesRef,
    currentPage: 0,
    currentPageRef,
    setPages,
    hardRefreshEpochRef,
    quietRevalidateMountedRef: mounted,
    quietRevalidateOwnerRef: { current: {} },
    quietRevalidateScopeRef: { current: { queryKey: `${queryKey}registered`, generation: 1 } }
  }
  const sources = { issues: { owner: 'o', repo: 'r' }, prs: null }
  const closed = { ...local, state: 'closed' as const, assignees: [user('alice')] }
  list.mockImplementation(async (args: { repoPath: string }) => {
    if (args.repoPath === remote.path) {
      throw new Error('Partial foreign source')
    }
    return { items: [closed], sources }
  })
  let cleanup: (() => void) | undefined
  await act(async () => {
    cleanup = runTaskPageGitHubQuietRefresh(
      model as Parameters<typeof runTaskPageGitHubQuietRefresh>[0]
    )
  }) // SAFETY: complete quiet owner input; network/store/projection are production.
  cleanup?.()
  expect(context.pages[2]![0]).toBe(foreignRow)
  expect(visible()).toEqual([])
  list.mockImplementation(async (args: { repoPath: string }) => ({
    items: args.repoPath === remote.path ? [] : [closed],
    sources
  }))
  await act(async () => {
    cleanup = runTaskPageGitHubQuietRefresh({ ...model, pages: context.pages } as Parameters<
      typeof runTaskPageGitHubQuietRefresh
    >[0])
  }) // SAFETY: same complete owner input.
  cleanup?.()
  expect(
    getLastConfirmedClientEntry(getTaskSourceCacheScope(source), repo.id, local.id, 'state')
  ).toBeUndefined()
  expect(context.pages[2]![0]).toBe(foreignRow)
  expect(visible()).toEqual([])
  const reentered = { ...local, title: 'Ordinary reentry', assignees: [user('bob')] }
  list.mockImplementation(async (args: { repoPath: string }) => ({
    items: [args.repoPath === remote.path ? { ...foreign, assignees: [user('alice')] } : reentered],
    sources
  }))
  currentPageRef.current = 2
  let loading = false
  await act(async () => {
    cleanup = runTaskPageGitHubLandingRefresh({
      ...model,
      taskResumeApplied: true,
      taskRefreshNonce: 1,
      workItemsInvalidationNonce: 0,
      lastFetchedNonceRef: { current: 0 },
      lastFetchedInvalidationNonceRef: { current: 0 },
      paginationGenerationRef: { current: 0 },
      landingGitHubRefreshKeysRef: { current: new Set() },
      githubResumeContextKey: 'owned-pages',
      githubResumeConsumedRef: { current: true },
      githubResumeContextRef: { current: 'owned-pages' },
      pendingGithubScrollRestoreRef: { current: 0 },
      countedTotalPagesRef: { current: null },
      retryingSourceKeys: new Set(),
      setRetryingSourceKeys: noop,
      setTasksLoading: (value: boolean) => {
        loading = value
      },
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
    } as Parameters<typeof runTaskPageGitHubLandingRefresh>[0]) // SAFETY: complete landing/numbered-restore input, real slice fetch and final setters.
  })
  cleanup?.()
  mounted.current = false
  expect(loading).toBe(false)
  expect(context.pages[0]?.some((row) => row.title === 'Ordinary reentry')).toBe(true)
  expect(context.pages[2]?.some((row) => row.title === 'Ordinary reentry')).toBe(true)
  expect(visible()).toEqual(['Ordinary reentry'])
  expect(list.mock.calls.some(([args]) => args.page === 3)).toBe(true)
  query = 'is:open assignee:cora'
  await mount(false, outputs, query, true)
  expect(visible()).toEqual(['Ordinary reentry', 'Foreign retained exit']) // new remote-admitted query has no prior local eligibility
})

import { VisibleReaders } from './github-task-refresh-visible-readers.test-fixture'
