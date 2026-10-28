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
const repoId = 'comment-race-repo'
const prRepo = { owner: 'Acme', repo: 'Widgets' }
const options = { repoId, prRepo }
const cacheKey = `${repoId}::pr-comments::acme/widgets::12`
const original: PRComment = {
  id: 10,
  author: 'reviewer',
  authorAvatarUrl: '',
  body: 'Before',
  createdAt: '2026-10-28T00:00:00Z',
  url: ''
}
const posted: PRComment = {
  ...original,
  id: 11,
  body: 'Posted reply',
  createdAt: '2026-10-28T00:01:00Z'
}

function makeStore(cached = true) {
  const store = createTestStore()
  store.setState({
    repos: [{ id: repoId, path: repoPath, displayName: 'Repo', badgeColor: '#000', addedAt: 0 }],
    commentsCache: cached ? { [cacheKey]: { data: [original], fetchedAt: 1 } } : {}
  })
  return store
}

beforeEach(() => {
  vi.clearAllMocks()
  resetRemoteRuntimeMocks()
  mockApi.gh.addIssueComment.mockResolvedValue({ ok: true, comment: posted })
  mockApi.gh.addPRReviewCommentReply.mockResolvedValue({ ok: true, comment: posted })
})

it.each([
  ['comment', true],
  ['comment', false],
  ['reply', true],
  ['reply', false]
] as const)('preserves a posted %s after an earlier read with cached=%s', async (kind, cached) => {
  const store = makeStore(cached)
  const oldRead = Promise.withResolvers<PRComment[]>()
  mockApi.gh.prComments.mockReturnValueOnce(oldRead.promise)
  const reading = store.getState().fetchPRComments(repoPath, 12, { ...options, force: true })
  const result =
    kind === 'comment'
      ? await store.getState().addPRConversationComment(repoPath, 12, posted.body, options)
      : await store.getState().addPRReviewCommentReply(repoPath, 12, 10, posted.body, options)
  expect(result.ok).toBe(true)
  const published = store.getState().commentsCache[cacheKey]
  expect(published?.data?.map(({ id }) => id)).toEqual(cached ? [10, 11] : [11])
  oldRead.resolve([original])
  await expect(reading).resolves.toEqual(published?.data)
  expect(store.getState().commentsCache[cacheKey]).toBe(published)
})

it('returns the posted reply to a caller sharing the earlier read', async () => {
  const store = makeStore()
  const oldRead = Promise.withResolvers<PRComment[]>()
  mockApi.gh.prComments.mockReturnValueOnce(oldRead.promise)
  const first = store.getState().fetchPRComments(repoPath, 12, options)
  await store.getState().addPRReviewCommentReply(repoPath, 12, 10, posted.body, options)
  const forced = store.getState().fetchPRComments(repoPath, 12, { ...options, force: true })
  oldRead.resolve([original])
  const expected = store.getState().commentsCache[cacheKey]?.data
  await expect(Promise.all([first, forced])).resolves.toEqual([expected, expected])
  expect(mockApi.gh.prComments).toHaveBeenCalledTimes(1)
})

it('accepts a later authoritative read, including server-side deletions', async () => {
  const store = makeStore()
  await store.getState().addPRConversationComment(repoPath, 12, posted.body, options)
  mockApi.gh.prComments.mockResolvedValueOnce([])
  await expect(
    store.getState().fetchPRComments(repoPath, 12, { ...options, force: true })
  ).resolves.toEqual([])
  expect(store.getState().commentsCache[cacheKey]?.data).toEqual([])
})

it('allows a pending read to publish after a failed write', async () => {
  const store = makeStore()
  const oldRead = Promise.withResolvers<PRComment[]>()
  mockApi.gh.prComments.mockReturnValueOnce(oldRead.promise)
  const reading = store.getState().fetchPRComments(repoPath, 12, { ...options, force: true })
  mockApi.gh.addIssueComment.mockResolvedValueOnce({ ok: false, error: 'Rejected' })
  expect(
    await store.getState().addPRConversationComment(repoPath, 12, posted.body, options)
  ).toMatchObject({ ok: false })
  oldRead.resolve([original, posted])
  await expect(reading).resolves.toEqual([original, posted])
  expect(store.getState().commentsCache[cacheKey]?.data).toEqual([original, posted])
})

it('accepts a read when a different PR receives a comment', async () => {
  const store = makeStore()
  const oldRead = Promise.withResolvers<PRComment[]>()
  mockApi.gh.prComments.mockReturnValueOnce(oldRead.promise)
  const reading = store.getState().fetchPRComments(repoPath, 12, { ...options, force: true })
  await store.getState().addPRConversationComment(repoPath, 13, posted.body, options)
  oldRead.resolve([original, posted])
  await expect(reading).resolves.toEqual([original, posted])
  expect(store.getState().commentsCache[cacheKey]?.data).toEqual([original, posted])
})

it('preserves posts for an explicit paired source while its old read finishes', async () => {
  const store = makeStore()
  const sourceContext = githubSourceContext('runtime:source-runtime', 'source-repo')
  const sourceOptions = { ...options, sourceContext }
  const sourceKey = `${getTaskSourceCacheScope(sourceContext)}::${cacheKey}`
  const oldRead = Promise.withResolvers<{
    id: string
    ok: true
    result: PRComment[]
    _meta: { runtimeId: string }
  }>()
  const started = Promise.withResolvers<void>()
  runtimeEnvironmentCall.mockImplementation((args) => {
    if (args.method === 'github.prComments') {
      started.resolve()
      return oldRead.promise
    }
    return {
      id: 'source-write',
      ok: true,
      result: { ok: true, comment: posted },
      _meta: { runtimeId: 'source-runtime' }
    }
  })
  const reading = store.getState().fetchPRComments(repoPath, 12, { ...sourceOptions, force: true })
  await started.promise
  expect(
    await store.getState().addPRConversationComment(repoPath, 12, posted.body, sourceOptions)
  ).toMatchObject({ ok: true })
  const published = store.getState().commentsCache[sourceKey]
  oldRead.resolve({
    id: 'source-read',
    ok: true,
    result: [original],
    _meta: { runtimeId: 'source-runtime' }
  })
  await expect(reading).resolves.toEqual(published?.data)
  expect(store.getState().commentsCache[sourceKey]).toBe(published)
  expect(store.getState().commentsCache[cacheKey]?.data).toEqual([original])
})
