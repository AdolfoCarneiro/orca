import { beforeEach, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import { githubReviewThreadRequest } from '../github/review-thread-request'
import {
  acquireReviewThreadResolution,
  releaseReviewThreadResolution
} from '@/lib/review-thread-resolution-pending'
import { createTestStore, mockApi, resetRemoteRuntimeMocks } from './github-slice-test-harness'

const repo: Repo = {
  id: 'admission-repo',
  path: '/repo',
  displayName: 'Repo',
  badgeColor: '',
  addedAt: 0
}
const source: TaskSourceContext = {
  kind: 'task-source',
  provider: 'github',
  projectId: 'project',
  repoId: repo.id,
  hostId: 'local'
}
const prRepo = { owner: 'acme', repo: 'widgets', host: 'github.com' }

beforeEach(() => {
  vi.clearAllMocks()
  resetRemoteRuntimeMocks()
})

function setup() {
  const store = createTestStore()
  store.setState({ repos: [repo] })
  const request = githubReviewThreadRequest(store.getState(), repo.path, 12, 'thread', {
    repoId: repo.id
  })
  store.setState({
    commentsCache: {
      [request.cacheKey]: {
        fetchedAt: 1,
        data: [
          {
            id: 1,
            author: 'reviewer',
            authorAvatarUrl: '',
            body: 'Review',
            url: '',
            createdAt: '',
            threadId: 'thread',
            isResolved: true
          }
        ]
      }
    }
  })
  return { store, request, resolve: store.getState().resolveReviewThread }
}

it('refuses programmatic overlap before any speculative cache write and permits false retries', async () => {
  const { store, request, resolve } = setup()
  const host = Promise.withResolvers<boolean>()
  mockApi.gh.resolveReviewThread.mockReturnValueOnce(host.promise).mockResolvedValueOnce(false)
  const first = resolve(repo.path, 12, 'thread', false, { repoId: repo.id })
  expect(store.getState().commentsCache[request.cacheKey]?.data?.[0].isResolved).toBe(false)
  await expect(resolve(repo.path, 12, 'thread', true, { repoId: repo.id, prRepo })).resolves.toBe(
    'busy'
  )
  expect(mockApi.gh.resolveReviewThread).toHaveBeenCalledTimes(1)
  expect(store.getState().commentsCache[request.cacheKey]?.data?.[0].isResolved).toBe(false)
  host.resolve(false)
  await expect(first).resolves.toBe(false)
  expect(store.getState().commentsCache[request.cacheKey]?.data?.[0].isResolved).toBe(true)
  await expect(resolve(repo.path, 12, 'thread', false, { repoId: repo.id })).resolves.toBe(false)
  expect(mockApi.gh.resolveReviewThread).toHaveBeenCalledTimes(2)
  expect(store.getState().commentsCache[request.cacheKey]?.data?.[0].isResolved).toBe(true)
})

it('adopts once and a stale or wrong admission cannot dispatch or clear another owner', async () => {
  const { resolve, request } = setup()
  const owner = acquireReviewThreadResolution(request.key)
  if (!owner) {
    throw new Error('Unexpected busy test key')
  }
  mockApi.gh.resolveReviewThread.mockResolvedValue(false)
  const options = { repoId: repo.id, threadResolutionAdmission: { owner, request } }
  try {
    await expect(resolve(repo.path, 13, 'thread', true, options)).resolves.toBe('busy')
    expect(mockApi.gh.resolveReviewThread).not.toHaveBeenCalled()
    await expect(resolve(repo.path, 12, 'thread', true, options)).resolves.toBe(false)
    await expect(resolve(repo.path, 12, 'thread', true, options)).resolves.toBe('busy')
    expect(acquireReviewThreadResolution(request.key)).toBe(null)
  } finally {
    releaseReviewThreadResolution(owner)
  }
  const next = acquireReviewThreadResolution(request.key)
  if (!next) {
    throw new Error('Missing next owner')
  }
  try {
    releaseReviewThreadResolution(owner)
    expect(acquireReviewThreadResolution(request.key)).toBe(null)
    await expect(resolve(repo.path, 12, 'thread', true, options)).resolves.toBe('busy')
  } finally {
    releaseReviewThreadResolution(next)
  }
  expect(mockApi.gh.resolveReviewThread).toHaveBeenCalledTimes(1)
})

it('canonicalizes default metadata and equivalent source routes while isolating actual endpoints, hosts, reviews and threads', () => {
  const { store, request } = setup()
  const prepare = (
    options: Parameters<typeof githubReviewThreadRequest>[4],
    review = 12,
    thread = 'thread'
  ) => githubReviewThreadRequest(store.getState(), repo.path, review, thread, options)
  expect(prepare({ repoId: repo.id, prRepo }).key).toBe(request.key)
  expect(prepare({ repoId: repo.id, prRepo: { ...prRepo, host: ' GitHub.COM ' } }).key).toBe(
    request.key
  )
  expect(prepare({ repoId: repo.id, sourceContext: source }).key).toBe(request.key)
  expect(
    prepare({
      repoId: repo.id,
      sourceContext: { ...source, projectId: 'other', accountLabel: 'other' }
    }).key
  ).toBe(request.key)
  expect(prepare({ repoId: repo.id, prRepo: { ...prRepo, host: 'enterprise.example' } }).key).toBe(
    request.key
  )
  expect(prepare({ repoId: repo.id }, 13).key).not.toBe(request.key)
  expect(prepare({ repoId: repo.id }, 12, 'other').key).not.toBe(request.key)
  store.setState({ repos: [{ ...repo, executionHostId: 'runtime:owner' }] })
  const owned = prepare({ repoId: repo.id })
  const explicit = prepare({
    repoId: repo.id,
    sourceContext: { ...source, hostId: 'runtime:owner' }
  })
  expect(explicit.target).toEqual({
    kind: 'environment',
    environmentId: 'owner',
    runtimeRepoId: repo.id
  })
  expect(explicit.key).toBe(owned.key)
  expect(
    prepare({ repoId: repo.id, sourceContext: { ...source, hostId: 'runtime:another' } }).key
  ).not.toBe(owned.key)
})

it('lets independent threads and reviews run while a mutation is pending', async () => {
  const { resolve } = setup()
  const host = Promise.withResolvers<boolean>()
  mockApi.gh.resolveReviewThread.mockReturnValueOnce(host.promise).mockResolvedValue(true)
  const first = resolve(repo.path, 12, 'thread', true, { repoId: repo.id })
  await expect(resolve(repo.path, 12, 'another', true, { repoId: repo.id })).resolves.toBe(true)
  await expect(resolve(repo.path, 13, 'thread', true, { repoId: repo.id })).resolves.toBe(true)
  expect(mockApi.gh.resolveReviewThread).toHaveBeenCalledTimes(3)
  host.resolve(false)
  await first
})

it('keeps absent and later known Enterprise targets excluded while remote identity hydrates', async () => {
  const { store, request, resolve } = setup()
  const host = Promise.withResolvers<boolean>()
  mockApi.gh.resolveReviewThread.mockReturnValueOnce(host.promise)
  const first = resolve(repo.path, 12, 'thread', false, { repoId: repo.id })
  const enterpriseTarget = { ...prRepo, host: 'github.enterprise.example' }
  store.setState({
    repos: [
      {
        ...repo,
        gitRemoteIdentity: {
          canonicalKey: 'github.enterprise.example/acme/widgets',
          remoteName: 'origin',
          remoteUrl: 'git@github.enterprise.example:acme/widgets.git'
        }
      }
    ]
  })
  const known = githubReviewThreadRequest(store.getState(), repo.path, 12, 'thread', {
    repoId: repo.id,
    prRepo: enterpriseTarget
  })
  expect(known.key).toBe(request.key)
  await expect(
    resolve(repo.path, 12, 'thread', true, { repoId: repo.id, prRepo: enterpriseTarget })
  ).resolves.toBe('busy')
  expect(mockApi.gh.resolveReviewThread).toHaveBeenCalledTimes(1)
  expect(store.getState().commentsCache[request.cacheKey]?.data?.[0].isResolved).toBe(false)
  host.resolve(false)
  await first
  mockApi.gh.resolveReviewThread.mockResolvedValueOnce(false)
  await expect(
    resolve(repo.path, 12, 'thread', false, { repoId: repo.id, prRepo: enterpriseTarget })
  ).resolves.toBe(false)
  expect(mockApi.gh.resolveReviewThread).toHaveBeenCalledTimes(2)
  expect(mockApi.gh.resolveReviewThread).toHaveBeenLastCalledWith(
    expect.objectContaining({ prRepo: enterpriseTarget })
  )
})
