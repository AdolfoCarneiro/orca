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

const conversation = { ...comments[0], id: 2, threadId: undefined, isResolved: undefined }
const postedComment = { ...conversation, id: 3, body: 'Fixing' }

it.each([false, true])(
  'reads and posts conversation replies only through the selected owner cache (runtime first: %s)',
  async (runtimeFirst) => {
    const { store, localEntry } = setup(runtimeFirst ? [remote, local] : [local, remote])
    const options = { repoId: remote.id, repoOwnerExecutionHostId: 'runtime:owner' as const }
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-read',
      ok: true,
      result: [conversation],
      _meta: {}
    })
    await expect(store.getState().fetchPRComments(remote.path, 12, options)).resolves.toEqual([
      conversation
    ])
    expect(store.getState().commentsCache[cacheKey(remote)]?.data).toEqual([conversation])
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-post',
      ok: true,
      result: { ok: true, comment: postedComment },
      _meta: {}
    })
    await expect(
      store.getState().addPRConversationComment(remote.path, 12, 'Fixing', options)
    ).resolves.toEqual({ ok: true, comment: postedComment })
    expect(
      store.getState().commentsCache[cacheKey(remote)]?.data?.map((comment) => comment.id)
    ).toEqual([2, 3])
    expect(store.getState().commentsCache[cacheKey(local)]).toBe(localEntry)
    expect(runtimeEnvironmentCall.mock.calls.map(([args]) => args)).toEqual([
      expect.objectContaining({ selector: 'owner', method: 'github.prComments' }),
      expect.objectContaining({ selector: 'owner', method: 'github.addIssueComment' })
    ])
    expect(mockApi.gh.prComments).not.toHaveBeenCalled()
    expect(mockApi.gh.addIssueComment).not.toHaveBeenCalled()
  }
)

it('pins local reads and conversation replies to desktop IPC despite runtime focus', async () => {
  const { store, settings } = setup()
  store.setState({ settings: { ...settings, activeRuntimeEnvironmentId: 'other' } })
  mockApi.gh.prComments.mockResolvedValue([conversation])
  mockApi.gh.addIssueComment.mockResolvedValue({ ok: true, comment: postedComment })
  const options = { repoId: local.id, repoOwnerExecutionHostId: 'local' as const }
  await store.getState().fetchPRComments(local.path, 12, options)
  await store.getState().addPRConversationComment(local.path, 12, 'Fixing', options)
  expect(mockApi.gh.prComments).toHaveBeenCalledWith(
    expect.objectContaining({ repoOwnerExecutionHostId: 'local' })
  )
  expect(mockApi.gh.addIssueComment).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'pr', repoOwnerExecutionHostId: 'local' })
  )
  expect(
    store.getState().commentsCache[cacheKey(local)]?.data?.map((comment) => comment.id)
  ).toEqual([2, 3])
  expect(store.getState().commentsCache[cacheKey(remote)]?.data).toEqual(comments)
  expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
})

it.each([
  { name: 'empty catalog', repos: [], path: remote.path, hostId: 'runtime:owner' as const },
  { name: 'removed owner', repos: [local], path: remote.path, hostId: 'runtime:owner' as const },
  {
    name: 'ambiguous owner',
    repos: [local, remote, { ...remote }],
    path: remote.path,
    hostId: 'runtime:owner' as const
  },
  {
    name: 'changed path',
    repos: [local, { ...remote, path: '/elsewhere' }],
    path: remote.path,
    hostId: 'runtime:owner' as const
  },
  { name: 'invalid owner', repos: [local, remote], path: remote.path, hostId: 'runtime:' as const }
])(
  'refuses read and conversation dispatch with an explicit $name before touching cache',
  async ({ repos, path, hostId }) => {
    const { store } = setup(repos)
    const cache = store.getState().commentsCache
    const options = { repoId: remote.id, repoOwnerExecutionHostId: hostId }
    await expect(store.getState().fetchPRComments(path, 12, options)).resolves.toEqual([])
    await expect(
      store.getState().addPRConversationComment(path, 12, 'Fixing', options)
    ).resolves.toMatchObject({ ok: false })
    expect(store.getState().commentsCache).toBe(cache)
    expect(mockApi.gh.prComments).not.toHaveBeenCalled()
    expect(mockApi.gh.addIssueComment).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  }
)

it('keeps rowless source-context reads and replies in their mapped repo and cache domain', async () => {
  const { store } = setup([])
  store.setState({ commentsCache: {} })
  const options = {
    repoId: local.id,
    sourceContext: source,
    repoOwnerExecutionHostId: 'local' as const
  }
  runtimeEnvironmentCall.mockResolvedValueOnce({
    id: 'rpc-read',
    ok: true,
    result: [conversation],
    _meta: {}
  })
  await store.getState().fetchPRComments(local.path, 12, options)
  runtimeEnvironmentCall.mockResolvedValueOnce({
    id: 'rpc-post',
    ok: true,
    result: { ok: true, comment: postedComment },
    _meta: {}
  })
  await store.getState().addPRConversationComment(local.path, 12, 'Fixing', options)
  const key = cacheKey(local, source)
  expect(Object.keys(store.getState().commentsCache)).toEqual([key])
  expect(store.getState().commentsCache[key]?.data?.map((comment) => comment.id)).toEqual([2, 3])
  for (const [args] of runtimeEnvironmentCall.mock.calls) {
    expect(args).toMatchObject({ selector: 'source', params: { repo: 'server-repo' } })
  }
  expect(mockApi.gh.prComments).not.toHaveBeenCalled()
  expect(mockApi.gh.addIssueComment).not.toHaveBeenCalled()
})
