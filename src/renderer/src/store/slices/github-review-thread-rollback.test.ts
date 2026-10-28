import { beforeEach, expect, it, vi } from 'vitest'
import type { PRComment } from '../../../../shared/github/comment-types'
import { getTaskSourceCacheScope } from '../../../../shared/task-source-context'
import {
  createTestStore,
  githubSourceContext,
  mockApi,
  resetRemoteRuntimeMocks,
  runtimeEnvironmentCall
} from './github-slice-test-harness'

const repoPath = '/repo'
const repoId = 'thread-rollback-repo'
const threadId = 'thread-10'
const options = { repoId, prRepo: { owner: 'Acme', repo: 'Widgets' } }
const cacheKey = `${repoId}::pr-comments::acme/widgets::12`
const original: PRComment = {
  id: 10,
  reactionSubjectId: 'IC_10',
  author: 'reviewer',
  authorAvatarUrl: '',
  body: 'Before',
  threadId,
  isResolved: false,
  createdAt: '2026-10-28T00:00:00Z',
  url: ''
}
const reply: PRComment = { ...original, id: 11, body: 'Posted reply' }

function makeStore(comments = [original]) {
  const store = createTestStore()
  store.setState({
    repos: [{ id: repoId, path: repoPath, displayName: 'Repo', badgeColor: '#000', addedAt: 0 }],
    commentsCache: { [cacheKey]: { data: comments, fetchedAt: 1 } }
  })
  return store
}

beforeEach(() => {
  vi.clearAllMocks()
  resetRemoteRuntimeMocks()
  mockApi.gh.addPRReviewCommentReply.mockResolvedValue({ ok: true, comment: reply })
  mockApi.gh.setPRCommentReaction.mockResolvedValue(true)
})

it.each(['false', 'throw'] as const)(
  'keeps a posted reply when a pending thread resolution fails with %s',
  async (failure) => {
    const store = makeStore()
    const result = Promise.withResolvers<boolean>()
    mockApi.gh.resolveReviewThread.mockReturnValueOnce(result.promise)
    const pending = store.getState().resolveReviewThread(repoPath, 12, threadId, true, options)
    expect(store.getState().commentsCache[cacheKey]?.data?.[0].isResolved).toBe(true)
    await expect(
      store.getState().addPRReviewCommentReply(repoPath, 12, 10, reply.body, options)
    ).resolves.toMatchObject({ ok: true })
    expect(store.getState().commentsCache[cacheKey]?.data).toHaveLength(2)
    if (failure === 'throw') {
      result.reject(new Error('offline'))
    } else {
      result.resolve(false)
    }
    await expect(pending).resolves.toBe(false)
    expect(store.getState().commentsCache[cacheKey]?.data).toEqual([original, reply])
  }
)

it.each(['false', 'throw'] as const)(
  'restores resolution on a REST reply when pending unresolve fails with %s',
  async (failure) => {
    const resolved = { ...original, isResolved: true }
    const store = makeStore([resolved])
    const result = Promise.withResolvers<boolean>()
    mockApi.gh.resolveReviewThread.mockReturnValueOnce(result.promise)
    const pending = store.getState().resolveReviewThread(repoPath, 12, threadId, false, options)
    expect(store.getState().commentsCache[cacheKey]?.data?.[0].isResolved).toBe(false)
    const restReply = { ...reply }
    delete restReply.isResolved
    mockApi.gh.addPRReviewCommentReply.mockResolvedValueOnce({ ok: true, comment: restReply })
    await expect(
      store
        .getState()
        .addPRReviewCommentReply(repoPath, 12, 10, reply.body, { ...options, threadId })
    ).resolves.toMatchObject({ ok: true })
    if (failure === 'throw') {
      result.reject(new Error('offline'))
    } else {
      result.resolve(false)
    }
    await expect(pending).resolves.toBe(false)
    expect(store.getState().commentsCache[cacheKey]?.data).toEqual([
      resolved,
      { ...restReply, isResolved: true }
    ])
  }
)

it('keeps a successful reaction on the thread whose resolution fails', async () => {
  const store = makeStore()
  const result = Promise.withResolvers<boolean>()
  mockApi.gh.resolveReviewThread.mockReturnValueOnce(result.promise)
  const pending = store.getState().resolveReviewThread(repoPath, 12, threadId, true, options)
  await expect(
    store.getState().setPRCommentReaction(repoPath, 12, 'IC_10', 'heart', true, options)
  ).resolves.toBe(true)
  const reactions = store.getState().commentsCache[cacheKey]?.data?.[0].reactions
  expect(reactions).toEqual([{ content: 'heart', count: 1, viewerHasReacted: true }])
  result.resolve(false)
  await expect(pending).resolves.toBe(false)
  expect(store.getState().commentsCache[cacheKey]?.data).toEqual([{ ...original, reactions }])
})

it('keeps a different thread resolved after an earlier thread update fails', async () => {
  const other = { ...original, id: 20, threadId: 'thread-20' }
  const store = makeStore([original, other])
  const result = Promise.withResolvers<boolean>()
  mockApi.gh.resolveReviewThread.mockReturnValueOnce(result.promise).mockResolvedValueOnce(true)
  const pending = store.getState().resolveReviewThread(repoPath, 12, threadId, true, options)
  await expect(
    store.getState().resolveReviewThread(repoPath, 12, other.threadId, true, options)
  ).resolves.toBe(true)
  result.resolve(false)
  await expect(pending).resolves.toBe(false)
  expect(store.getState().commentsCache[cacheKey]?.data).toEqual([
    original,
    { ...other, isResolved: true }
  ])
})

it('does not resurrect a cache entry cleared while thread resolution was pending', async () => {
  const store = makeStore()
  const result = Promise.withResolvers<boolean>()
  mockApi.gh.resolveReviewThread.mockReturnValueOnce(result.promise)
  const pending = store.getState().resolveReviewThread(repoPath, 12, threadId, true, options)
  store.getState().refreshAllGitHub()
  result.resolve(false)
  await expect(pending).resolves.toBe(false)
  expect(store.getState().commentsCache[cacheKey]).toBeUndefined()
})

it('keeps replies on the paired source when its pending thread resolution fails', async () => {
  const store = makeStore()
  const resolved = { ...original, isResolved: true }
  const restReply = { ...reply }
  delete restReply.isResolved
  const sourceContext = githubSourceContext('runtime:source-runtime', 'source-repo')
  const sourceOptions = { ...options, sourceContext }
  const sourceKey = `${getTaskSourceCacheScope(sourceContext)}::${cacheKey}`
  store.setState({
    commentsCache: {
      ...store.getState().commentsCache,
      [sourceKey]: { data: [resolved], fetchedAt: 1 }
    }
  })
  const result = Promise.withResolvers<{
    id: string
    ok: true
    result: boolean
    _meta: { runtimeId: string }
  }>()
  const started = Promise.withResolvers<void>()
  runtimeEnvironmentCall.mockImplementation((args) => {
    if (args.method === 'github.resolveReviewThread') {
      started.resolve()
      return result.promise
    }
    return {
      id: 'source-write',
      ok: true,
      result: { ok: true, comment: restReply },
      _meta: { runtimeId: 'source-runtime' }
    }
  })
  const pending = store.getState().resolveReviewThread(repoPath, 12, threadId, false, sourceOptions)
  await started.promise
  await expect(
    store.getState().addPRReviewCommentReply(repoPath, 12, 10, reply.body, sourceOptions)
  ).resolves.toMatchObject({ ok: true })
  result.resolve({
    id: 'source-resolution',
    ok: true,
    result: false,
    _meta: { runtimeId: 'source-runtime' }
  })
  await expect(pending).resolves.toBe(false)
  expect(store.getState().commentsCache[sourceKey]?.data).toEqual([
    resolved,
    { ...restReply, isResolved: true }
  ])
  expect(store.getState().commentsCache[cacheKey]?.data).toEqual([original])
})
