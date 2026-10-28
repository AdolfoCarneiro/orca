import { beforeEach, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import { getDefaultSettings } from '../../../../shared/constants'
import { prCommentsCacheSuffix, sourceScopedRepoCacheKey } from '../github/cache-identity'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  runtimeEnvironmentCall
} from './github-slice-test-harness'
import { buildSnapshottedThreadResolver } from '../../components/right-sidebar/pr-comment-snapshotted-thread-resolver'

const local: Repo = {
  id: 'shared-repo',
  path: '/repo',
  displayName: 'Repo',
  badgeColor: '',
  addedAt: 1,
  executionHostId: 'local'
}
const remote: Repo = { ...local, executionHostId: 'runtime:owner' }
const comments = [
  {
    id: 1,
    author: 'reviewer',
    authorAvatarUrl: '',
    body: 'Review',
    createdAt: '',
    url: '',
    threadId: 'thread',
    isResolved: false
  }
]
const source: TaskSourceContext = {
  kind: 'task-source',
  provider: 'github',
  projectId: 'project',
  repoId: 'server-repo',
  hostId: 'runtime:source'
}
function cacheKey(repo: Repo, sourceContext?: TaskSourceContext) {
  return sourceScopedRepoCacheKey(
    repo.path,
    repo.id,
    prCommentsCacheSuffix(12),
    undefined,
    repo.connectionId,
    repo.executionHostId,
    sourceContext,
    true
  )
}
function setup(repos: Repo[] = [local, remote]) {
  const store = createTestStore()
  const localEntry = { data: comments, fetchedAt: 1 }
  const settings = getDefaultSettings('/tmp/review-thread-owner')
  store.setState({
    settings,
    repos,
    commentsCache: {
      [cacheKey(local)]: localEntry,
      [cacheKey(remote)]: { data: comments, fetchedAt: 1 }
    }
  })
  return { store, localEntry, settings }
}
beforeEach(() => {
  vi.clearAllMocks()
  resetRemoteRuntimeMocks()
})

it.each([false, true])(
  'updates only the selected runtime cache, including false rollback (runtime first: %s)',
  async (runtimeFirst) => {
    const { store, localEntry } = setup(runtimeFirst ? [remote, local] : [local, remote])
    const host = Promise.withResolvers<{ id: string; ok: true; result: boolean; _meta: {} }>()
    runtimeEnvironmentCall.mockReturnValueOnce(host.promise)
    const pending = store.getState().resolveReviewThread(remote.path, 12, 'thread', true, {
      repoId: remote.id,
      repoOwnerExecutionHostId: 'runtime:owner'
    })
    expect(store.getState().commentsCache[cacheKey(remote)]?.data?.[0].isResolved).toBe(true)
    expect(store.getState().commentsCache[cacheKey(local)]).toBe(localEntry)
    host.resolve({ id: 'rpc-owner', ok: true, result: false, _meta: {} })
    await expect(pending).resolves.toBe(false)
    expect(store.getState().commentsCache[cacheKey(remote)]?.data?.[0].isResolved).toBe(false)
    expect(store.getState().commentsCache[cacheKey(local)]).toBe(localEntry)
    expect(mockApi.gh.resolveReviewThread).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({ selector: 'owner', method: 'github.resolveReviewThread' })
    )
  }
)

it('keeps a selected local thread on desktop IPC while another runtime is focused', async () => {
  const { store, settings } = setup()
  store.setState({
    settings: { ...settings, activeRuntimeEnvironmentId: 'other' }
  })
  mockApi.gh.resolveReviewThread.mockResolvedValue(true)
  await expect(
    store.getState().resolveReviewThread(local.path, 12, 'thread', true, {
      repoId: local.id,
      repoOwnerExecutionHostId: 'local'
    })
  ).resolves.toBe(true)
  expect(store.getState().commentsCache[cacheKey(local)]?.data?.[0].isResolved).toBe(true)
  expect(store.getState().commentsCache[cacheKey(remote)]?.data?.[0].isResolved).toBe(false)
  expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  expect(mockApi.gh.resolveReviewThread).toHaveBeenCalledWith(
    expect.objectContaining({ repoOwnerExecutionHostId: 'local' })
  )
})

it('uses the matching owner ID for path-only callers with distinct host registrations', async () => {
  const { store } = setup([local, { ...remote, id: 'runtime-repo' }])
  runtimeEnvironmentCall.mockResolvedValue({ id: 'rpc-owner', ok: true, result: true, _meta: {} })
  await expect(
    store.getState().resolveReviewThread(remote.path, 12, 'thread', true, {
      repoOwnerExecutionHostId: 'runtime:owner'
    })
  ).resolves.toBe(true)
  expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
    expect.objectContaining({
      selector: 'owner',
      params: expect.objectContaining({ repo: 'runtime-repo' })
    })
  )
  expect(mockApi.gh.resolveReviewThread).not.toHaveBeenCalled()
})

it('selects a different-path runtime twin by owner and refuses a changed or missing owner before optimism', async () => {
  const otherPath = { ...remote, path: '/server/repo' }
  const { store } = setup([local, otherPath])
  runtimeEnvironmentCall.mockResolvedValue({ id: 'rpc-owner', ok: true, result: true, _meta: {} })
  await expect(
    store.getState().resolveReviewThread(otherPath.path, 12, 'thread', true, {
      repoId: remote.id,
      repoOwnerExecutionHostId: 'runtime:owner'
    })
  ).resolves.toBe(true)
  const cache = store.getState().commentsCache
  store.setState({ repos: [local] })
  runtimeEnvironmentCall.mockClear()
  for (const repoOwnerExecutionHostId of ['runtime:owner', 'runtime:'] as const) {
    await expect(
      store.getState().resolveReviewThread(local.path, 12, 'thread', true, {
        repoId: local.id,
        repoOwnerExecutionHostId
      })
    ).resolves.toBe(false)
    expect(store.getState().commentsCache).toBe(cache)
  }
  expect(mockApi.gh.resolveReviewThread).not.toHaveBeenCalled()
  expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
})

it('refuses unqualified identical-path twins before touching either cache', async () => {
  const { store } = setup()
  const cache = store.getState().commentsCache
  await expect(
    store.getState().resolveReviewThread(local.path, 12, 'thread', true, {
      repoId: local.id
    })
  ).resolves.toBe(false)
  expect(store.getState().commentsCache).toBe(cache)
  expect(mockApi.gh.resolveReviewThread).not.toHaveBeenCalled()
  expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
})

it('preserves a real row-less runtime source, its mapped repo ID, and its cache domain', async () => {
  const { store } = setup([])
  const key = cacheKey(local, source)
  store.setState({ commentsCache: { [key]: { data: comments, fetchedAt: 1 } } })
  runtimeEnvironmentCall.mockResolvedValue({ id: 'rpc-source', ok: true, result: true, _meta: {} })
  await expect(
    store.getState().resolveReviewThread(local.path, 12, 'thread', true, {
      repoId: local.id,
      sourceContext: source,
      repoOwnerExecutionHostId: 'local'
    })
  ).resolves.toBe(true)
  expect(Object.keys(store.getState().commentsCache)).toEqual([key])
  expect(store.getState().commentsCache[key]?.data?.[0].isResolved).toBe(true)
  expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
    expect.objectContaining({
      selector: 'source',
      params: expect.objectContaining({ repo: 'server-repo' })
    })
  )
  expect(mockApi.gh.resolveReviewThread).not.toHaveBeenCalled()
})

it('keeps delayed AI resolution on its captured owner after runtime focus changes', async () => {
  const { store, settings } = setup()
  const onResolvedOptimistically = vi.fn()
  const resolve = buildSnapshottedThreadResolver({
    provider: 'github',
    githubResolveTarget: {
      repoPath: remote.path,
      repoId: remote.id,
      prNumber: 12,
      repoOwnerExecutionHostId: 'runtime:owner'
    },
    resolveReviewThread: store.getState().resolveReviewThread,
    resolveGitLabDiscussion: vi.fn(),
    isPanelStillOnLaunchReview: () => false,
    onResolvedOptimistically,
    onResolveFailed: vi.fn()
  })
  store.setState({
    settings: { ...settings, activeRuntimeEnvironmentId: 'other' }
  })
  runtimeEnvironmentCall.mockResolvedValue({ id: 'rpc-owner', ok: true, result: true, _meta: {} })
  await expect(resolve('thread')).resolves.toBe(true)
  expect(store.getState().commentsCache[cacheKey(remote)]?.data?.[0].isResolved).toBe(true)
  expect(store.getState().commentsCache[cacheKey(local)]?.data?.[0].isResolved).toBe(false)
  expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
    expect.objectContaining({ selector: 'owner' })
  )
  expect(mockApi.gh.resolveReviewThread).not.toHaveBeenCalled()
  expect(onResolvedOptimistically).not.toHaveBeenCalled()
})
