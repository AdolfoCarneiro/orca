// @vitest-environment happy-dom

import { useRef, useState } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type { Repo } from '../../../../../shared/repo-types'
import type { PRComment } from '../../../../../shared/github/comment-types'
import { useAppStore } from '@/store'
import { useActiveWorktree, useRepoById } from '@/store/selectors'
import {
  fetchRepoCatalogForTarget,
  mergeFetchedRepoCatalog
} from '@/store/repos/repo-catalog-merge'
import { sourceScopedRepoCacheKey, prCommentsCacheSuffix } from '@/store/github/cache-identity'
import {
  makePR,
  makePRRefreshWorktree,
  mockApi,
  resetRemoteRuntimeMocks,
  runtimeEnvironmentCall
} from '@/store/slices/github-slice-test-harness'
import { useChecksPanelCommentResolution } from './use-checks-panel-comment-resolution'
import { gitHubPRToChecksPanelReview } from '../checks-panel-review'

vi.mock('@/components/tab-bar/use-new-tab-agent-menu-rows', () => ({
  useAgentMenuObservation: () => ({ preferencesPending: true })
}))
vi.mock('@/hooks/useAgentDetectionTarget', () => ({
  useAgentDetectionTargetForWorktree: () => null
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

const browserWindow = document.defaultView
if (!browserWindow) {
  throw new Error('Missing test window')
}
Object.assign(browserWindow, { api: mockApi })
Object.defineProperty(globalThis, 'window', { value: browserWindow, configurable: true })
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const originalState = useAppStore.getState()
const registeredRepo: Repo = {
  id: 'registered-repo',
  path: '/workspace/widgets',
  displayName: 'Widgets',
  badgeColor: '',
  addedAt: 1
}
const pr = makePR({ prRepo: { owner: 'acme', repo: 'widgets' } })
const comments: PRComment[] = [
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
function useManualChecks() {
  const activeWorktree = useActiveWorktree()
  const repo = useRepoById(activeWorktree?.repoId ?? null)
  const [panelComments, setComments] = useState(comments)
  const resolution = useChecksPanelCommentResolution({
    activeWorktree,
    activeWorktreeId: activeWorktree?.id ?? null,
    repo,
    resolveReviewThread: useAppStore.getState().resolveReviewThread,
    claimedCommentResolutionRef: useRef(null),
    pendingCommentResolutionRef: useRef(null),
    commentResolutionLaunchAcceptedRef: useRef(false),
    commentResolutionAckBusy: false,
    commentsLoading: false,
    detectedAgentIds: null,
    setAgentComposerState: () => {},
    setComments,
    settings: useAppStore.getState().settings,
    activeGitLabReview: null,
    activeReview: gitHubPRToChecksPanelReview(pr),
    pr,
    prNumber: pr.number,
    sourceControlAiActionsVisible: false,
    branch: 'feature',
    prCacheKey: 'owner-review',
    isCurrentAsyncResult: () => true
  })
  return { ...resolution, repo, activeWorktree, comments: panelComments }
}
function key(repo: Repo) {
  return sourceScopedRepoCacheKey(
    repo.path,
    repo.id,
    prCommentsCacheSuffix(pr.number, pr.prRepo),
    undefined,
    repo.connectionId,
    repo.executionHostId,
    undefined,
    true
  )
}
async function catalog(nestedSsh = false) {
  Object.assign(mockApi.repos, { list: vi.fn().mockResolvedValue([registeredRepo]) })
  const remote = nestedSsh ? { ...registeredRepo, connectionId: 'private' } : registeredRepo
  runtimeEnvironmentCall.mockImplementation(async (args) => ({
    id: 'rpc-catalog',
    ok: true,
    result:
      args.method === 'repo.list'
        ? { repos: [remote] }
        : args.method === 'project.list'
          ? { projects: [] }
          : { setups: [] },
    _meta: {}
  }))
  let repos: readonly Repo[] = []
  const local = await fetchRepoCatalogForTarget({ kind: 'local' }, repos)
  repos = mergeFetchedRepoCatalog(local, repos).repos
  const paired = await fetchRepoCatalogForTarget(
    { kind: 'environment', environmentId: 'self' },
    repos
  )
  repos = mergeFetchedRepoCatalog(paired, repos).repos
  const localRepo = repos.find((repo) => repo.executionHostId === 'local')
  const remoteRepo = repos.find((repo) => repo.executionHostId === 'runtime:self')
  if (!localRepo || !remoteRepo) {
    throw new Error('Missing adopted catalog row')
  }
  const worktree = makePRRefreshWorktree({
    id: `${registeredRepo.id}::${registeredRepo.path}`,
    repoId: registeredRepo.id,
    path: registeredRepo.path,
    hostId: nestedSsh ? 'ssh:private' : 'runtime:self',
    ...(nestedSsh ? { runtimeOwnerEnvironmentId: 'self' } : {})
  })
  const localEntry = { data: comments, fetchedAt: 1 }
  useAppStore.setState({
    repos,
    activeRepoId: registeredRepo.id,
    activeWorktreeId: worktree.id,
    activeWorkspaceExecutionHostId: worktree.hostId,
    worktreesByRepo: { [registeredRepo.id]: [worktree] },
    commentsCache: {
      [key(localRepo)]: localEntry,
      [key(remoteRepo)]: { data: comments, fetchedAt: 1 }
    }
  })
  runtimeEnvironmentCall.mockReset()
  return { localRepo, remoteRepo, localEntry }
}
beforeEach(() => {
  vi.clearAllMocks()
  resetRemoteRuntimeMocks()
})
afterEach(() => {
  cleanup()
  useAppStore.setState(originalState, true)
})

it.each([false, true])(
  'routes the actual selected manual model through its credential owner and rolls back only that cache (nested SSH: %s)',
  async (nestedSsh) => {
    const { remoteRepo, localRepo, localEntry } = await catalog(nestedSsh)
    const host = Promise.withResolvers<{ id: string; ok: true; result: boolean; _meta: {} }>()
    runtimeEnvironmentCall.mockReturnValueOnce(host.promise)
    const { result } = renderHook(useManualChecks)
    expect(result.current.repo).toBe(remoteRepo)
    expect(result.current.activeWorktree?.hostId).toBe(nestedSsh ? 'ssh:private' : 'runtime:self')
    let pending = Promise.resolve(false)
    act(() => {
      pending = result.current.handleResolve('thread', true)
    })
    expect(result.current.comments[0]?.isResolved).toBe(true)
    expect(useAppStore.getState().commentsCache[key(remoteRepo)]?.data?.[0].isResolved).toBe(true)
    expect(useAppStore.getState().commentsCache[key(localRepo)]).toBe(localEntry)
    await act(async () => {
      host.resolve({ id: 'rpc-resolve', ok: true, result: false, _meta: {} })
      await pending
    })
    expect(result.current.comments[0]?.isResolved).toBe(false)
    expect(useAppStore.getState().commentsCache[key(remoteRepo)]?.data?.[0].isResolved).toBe(false)
    expect(useAppStore.getState().commentsCache[key(localRepo)]).toBe(localEntry)
    expect(mockApi.gh.resolveReviewThread).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'self',
        method: 'github.resolveReviewThread'
      })
    )
  }
)

it('refuses a stale manual handler after its selected owner disappears, before local optimism', async () => {
  const { localRepo } = await catalog()
  const { result } = renderHook(useManualChecks)
  const resolve = result.current.handleResolve
  const previous = result.current.comments
  act(() => useAppStore.setState({ repos: [localRepo] }))
  const cache = useAppStore.getState().commentsCache
  await act(async () => {
    await expect(resolve('thread', true, { notifyOnFailure: false })).resolves.toBe(false)
  })
  expect(result.current.comments).toBe(previous)
  expect(useAppStore.getState().commentsCache).toBe(cache)
  expect(mockApi.gh.resolveReviewThread).not.toHaveBeenCalled()
  expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  expect(toast.error).not.toHaveBeenCalled()
  await act(async () => {
    await expect(resolve('thread', true)).resolves.toBe(false)
  })
  expect(toast.error).toHaveBeenCalledWith(
    'The machine that owns this repository is not known yet. Reconnect it and try again.'
  )
})

it('still reports a failed write after the selected owner changes while guarding panel rollback', async () => {
  const { localRepo } = await catalog()
  const host = Promise.withResolvers<{ id: string; ok: true; result: boolean; _meta: {} }>()
  runtimeEnvironmentCall.mockReturnValueOnce(host.promise)
  const { result } = renderHook(useManualChecks)
  let pending = Promise.resolve(false)
  act(() => {
    pending = result.current.handleResolve('thread', true)
  })
  act(() => useAppStore.setState({ repos: [localRepo] }))
  await act(async () => {
    host.resolve({ id: 'rpc-resolve', ok: true, result: false, _meta: {} })
    await expect(pending).resolves.toBe(false)
  })
  expect(result.current.comments[0]?.isResolved).toBe(true)
  expect(toast.error).toHaveBeenCalledOnce()
})
