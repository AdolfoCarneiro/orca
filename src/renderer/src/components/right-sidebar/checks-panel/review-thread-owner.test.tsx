// @vitest-environment happy-dom

import { useCallback, useRef, useState } from 'react'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type { Repo } from '../../../../../shared/repo-types'
import type { ExecutionHostId } from '../../../../../shared/execution-host'
import type { PRComment } from '../../../../../shared/github/comment-types'
import type { PRInfo } from '../../../../../shared/github/pull-request-types'
import type { GitLabProjectRef } from '../../../../../shared/gitlab-types'
import { getDefaultSettings } from '../../../../../shared/constants'
import { getDefaultSourceControlAiSettings } from '../../../../../shared/source-control-ai'
import { getGitHubPRCacheKey } from '../../../../../shared/github/github-cache-key'
import { getPRCommentGroupId } from '../../../../../shared/pr-comment-groups'
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
import { useChecksPanelCommentMutations } from './use-checks-panel-comment-mutations'
import { gitHubPRToChecksPanelReview } from '../checks-panel-review'
import { checksPanelAsyncResultKey } from '../checks-panel-async-result-key'
import { useChecksPanelReviewData } from './use-checks-panel-review-data'
import { useChecksPanelAiQueue } from './use-checks-panel-ai-queue'
import { useChecksPanelAiAcknowledgement } from './use-checks-panel-ai-acknowledgement'
import type { ChecksAgentComposerState } from './panel-state-types'
import {
  clearPRCommentsListSelectionsForTests,
  usePRCommentsListSelection,
  type PRCommentsListSelectionClearRequest
} from '../pr-comments-list-selection'
import { clearPendingPRCommentAiAck } from '../pr-comments-ai-launch-ack'

vi.mock('@/components/tab-bar/use-new-tab-agent-menu-rows', () => ({
  useAgentMenuObservation: () => ({ preferencesPending: true })
}))
vi.mock('@/hooks/useAgentDetectionTarget', () => ({
  useAgentDetectionTargetForWorktree: () => null
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), message: vi.fn() } }))

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
function key(repo: Repo, review = pr) {
  return sourceScopedRepoCacheKey(
    repo.path,
    repo.id,
    prCommentsCacheSuffix(review.number, review.prRepo),
    undefined,
    repo.connectionId,
    repo.executionHostId,
    undefined,
    true
  )
}
async function catalog(
  nestedSsh = false,
  runtimeFirst = false,
  selectedLocal = false,
  remotePath = registeredRepo.path
) {
  Object.assign(mockApi.repos, { list: vi.fn().mockResolvedValue([registeredRepo]) })
  const remote = {
    ...registeredRepo,
    path: remotePath,
    ...(nestedSsh ? { connectionId: 'private' } : {})
  }
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
  const targets = runtimeFirst
    ? [{ kind: 'environment' as const, environmentId: 'self' }, { kind: 'local' as const }]
    : [{ kind: 'local' as const }, { kind: 'environment' as const, environmentId: 'self' }]
  for (const target of targets) {
    repos = mergeFetchedRepoCatalog(await fetchRepoCatalogForTarget(target, repos), repos).repos
  }
  const localRepo = repos.find((repo) => repo.executionHostId === 'local')
  const remoteRepo = repos.find((repo) => repo.executionHostId === 'runtime:self')
  if (!localRepo || !remoteRepo) {
    throw new Error('Missing adopted catalog row')
  }
  const worktree = makePRRefreshWorktree({
    id: `${registeredRepo.id}::${registeredRepo.path}`,
    repoId: registeredRepo.id,
    path: selectedLocal ? registeredRepo.path : remotePath,
    hostId: selectedLocal ? 'local' : nestedSsh ? 'ssh:private' : 'runtime:self',
    ...(nestedSsh ? { runtimeOwnerEnvironmentId: 'self' } : {})
  })
  const localEntry = { data: comments, fetchedAt: 1 }
  const settings = getDefaultSettings('/tmp/pr-comment-owner')
  settings.sourceControlAi = { ...getDefaultSourceControlAiSettings(), actions: {} }
  settings.activeRuntimeEnvironmentId = 'self'
  useAppStore.setState({
    settings,
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
  Object.assign(mockApi.gh, { onWorkItemMutated: () => () => {} })
})
afterEach(() => {
  cleanup()
  clearPRCommentsListSelectionsForTests()
  clearPendingPRCommentAiAck()
  useAppStore.setState(originalState, true)
})

function useLoadedChecks(review: PRInfo, worktreeHostId?: ExecutionHostId) {
  const selectedWorktree = useActiveWorktree()
  const activeWorktree =
    selectedWorktree && worktreeHostId !== undefined
      ? { ...selectedWorktree, hostId: worktreeHostId }
      : selectedWorktree
  const branch = activeWorktree?.branch ?? ''
  const repo = useRepoById(activeWorktree?.repoId ?? null)
  const settings = useAppStore((state) => state.settings)
  const fetchPRComments = useAppStore((state) => state.fetchPRComments)
  const [panelComments, setComments] = useState<PRComment[]>([])
  const [commentsLoading, setCommentsLoading] = useState(false)
  const [, setCommentsError] = useState<string | null>(null)
  const [composer, setAgentComposerState] = useState<ChecksAgentComposerState | null>(null)
  const [busy, setBusy] = useState(false)
  const [clearRequest, setCommentsSelectionClearRequest] =
    useState<PRCommentsListSelectionClearRequest | null>(null)
  const commentsRef = useRef(panelComments)
  commentsRef.current = panelComments
  const pendingCommentResolutionRef = useRef<NonNullable<
    ChecksAgentComposerState['commentResolution']
  > | null>(null)
  const claimedCommentResolutionRef = useRef<NonNullable<
    ChecksAgentComposerState['commentResolution']
  > | null>(null)
  const commentResolutionLaunchAcceptedRef = useRef(false)
  const commentResolutionAckBusyRef = useRef(false)
  const commentsSelectionClearTokenRef = useRef(0)
  const gitLabProjectRefRef = useRef<GitLabProjectRef | null>(null)
  const prCacheKey = repo
    ? getGitHubPRCacheKey(
        repo.path,
        repo.id,
        branch,
        settings,
        repo.connectionId,
        repo.executionHostId,
        true
      )
    : ''
  const stateRequestKey = checksPanelAsyncResultKey(
    prCacheKey,
    branch,
    review.number,
    review.prRepo,
    review.headSha
  )
  const asyncResultKeyRef = useRef(stateRequestKey)
  asyncResultKeyRef.current = stateRequestKey
  const isCurrentAsyncResult = useCallback(
    (requestKey: string) => requestKey === asyncResultKeyRef.current,
    []
  )
  const setCommentResolutionAckBusyNow = useCallback((value: boolean) => {
    commentResolutionAckBusyRef.current = value
    setBusy(value)
  }, [])
  const data = useChecksPanelReviewData({
    activeGitLabReview: null,
    branch,
    fetchPRCheckDetails: vi.fn(),
    fetchPRComments,
    gitLabProjectRefRef,
    isCurrentAsyncResult,
    isPanelVisible: true,
    pr: review,
    prCacheKey,
    prNumber: review.number,
    repo,
    activeWorktree,
    setComments,
    setCommentsError,
    setCommentsLoading
  })
  const ack = useChecksPanelAiAcknowledgement({
    addPRConversationComment: useAppStore.getState().addPRConversationComment,
    addPRReviewCommentReply: useAppStore.getState().addPRReviewCommentReply,
    resolveReviewThread: useAppStore.getState().resolveReviewThread,
    asyncResultKeyRef,
    claimedCommentResolutionRef,
    commentsRef,
    commentsSelectionClearTokenRef,
    pendingCommentResolutionRef,
    setCommentResolutionAckBusyNow,
    setComments,
    setCommentsSelectionClearRequest,
    commentResolutionLaunchAcceptedRef,
    fetchComments: data.fetchComments,
    fetchGitLabDetails: vi.fn()
  })
  const resolution = useChecksPanelCommentResolution({
    activeWorktree,
    activeWorktreeId: activeWorktree?.id ?? null,
    branch,
    claimedCommentResolutionRef,
    commentResolutionAckBusy: busy,
    commentsLoading,
    detectedAgentIds: null,
    isCurrentAsyncResult,
    pendingCommentResolutionRef,
    pr: review,
    prCacheKey,
    prNumber: review.number,
    repo,
    resolveReviewThread: useAppStore.getState().resolveReviewThread,
    setAgentComposerState,
    setComments,
    settings,
    commentResolutionLaunchAcceptedRef,
    activeGitLabReview: null,
    activeReview: gitHubPRToChecksPanelReview(review),
    sourceControlAiActionsVisible: true
  })
  const queue = useChecksPanelAiQueue({
    ...ack,
    activeConflictReview: null,
    activeReview: gitHubPRToChecksPanelReview(review),
    activeWorktree,
    activeWorktreeId: activeWorktree?.id ?? null,
    activeWorktreePath: activeWorktree?.path ?? null,
    activeConnectionId: repo?.connectionId ?? null,
    activeSourceControlLaunchPlatform: 'linux',
    settings,
    asyncResultKeyRef,
    claimedCommentResolutionRef,
    commentResolutionAckBusyRef,
    commentResolutionLaunchAcceptedRef,
    pendingCommentResolutionRef,
    pr: review,
    prNumber: review.number,
    repo,
    resolveCommentsWithAIDisabledReason: resolution.resolveCommentsWithAIDisabledReason,
    setAgentComposerState,
    sourceControlAiActionsVisible: true,
    stateRequestKey
  })
  const selection = usePRCommentsListSelection(panelComments, stateRequestKey, clearRequest)
  const mutations = useChecksPanelCommentMutations({
    activeWorktree,
    addPRConversationComment: useAppStore.getState().addPRConversationComment,
    addPRReviewCommentReply: useAppStore.getState().addPRReviewCommentReply,
    setPRCommentReaction: useAppStore.getState().setPRCommentReaction,
    branch,
    commentsRef,
    confirm: vi.fn(),
    repo,
    setComments,
    commentsDisabledReason: resolution.commentsDisabledReason,
    isCurrentAsyncResult,
    pr: review,
    prCacheKey,
    prNumber: review.number
  })
  return {
    ...mutations,
    ...queue,
    ...selection,
    ...data,
    repo,
    comments: panelComments,
    commentsLoading,
    composer,
    busy
  }
}

const conversation: PRComment = {
  id: 41,
  author: 'reviewer',
  authorAvatarUrl: '',
  body: 'Check compatibility',
  createdAt: '2026-10-28T13:00:00Z',
  url: 'https://github.com/acme/widgets/pull/12#issuecomment-41'
}
const postedComment: PRComment = { ...conversation, id: 91, author: 'agent', body: 'Fixing' }
const inlineComment: PRComment = {
  ...conversation,
  id: 42,
  threadId: 'thread-42',
  reactionSubjectId: 'GQL42',
  isResolved: false,
  path: 'src/widget.ts',
  line: 8,
  url: 'https://github.com/acme/widgets/pull/12#discussion_r42'
}

it.each([
  { runtimeFirst: false, selectedLocal: false, nestedSsh: false, remotePath: registeredRepo.path },
  { runtimeFirst: true, selectedLocal: false, nestedSsh: false, remotePath: registeredRepo.path },
  { runtimeFirst: true, selectedLocal: true, nestedSsh: false, remotePath: registeredRepo.path },
  { runtimeFirst: false, selectedLocal: false, nestedSsh: true, remotePath: '/server/widgets' }
])(
  'keeps all manual comment mutations on the selected owner and cache (%j)',
  async ({ runtimeFirst, selectedLocal, nestedSsh, remotePath }) => {
    const { localRepo, remoteRepo } = await catalog(
      nestedSsh,
      runtimeFirst,
      selectedLocal,
      remotePath
    )
    const selected = selectedLocal ? localRepo : remoteRepo
    const foreign = selectedLocal ? remoteRepo : localRepo
    const foreignEntry = useAppStore.getState().commentsCache[key(foreign)]
    const freshComments = [conversation, inlineComment]
    let nextId = 91
    const posted = () => ({ ok: true as const, comment: { ...postedComment, id: nextId++ } })
    mockApi.gh.prComments.mockResolvedValue(freshComments)
    mockApi.gh.addPRReviewCommentReply.mockImplementation(async () => posted())
    mockApi.gh.addIssueComment.mockImplementation(async () => posted())
    mockApi.gh.setPRCommentReaction.mockResolvedValue(true)
    runtimeEnvironmentCall.mockImplementation(async (args) => ({
      id: 'rpc-manual',
      ok: true,
      result:
        args.method === 'github.prComments'
          ? freshComments
          : args.method === 'github.setPRCommentReaction'
            ? true
            : posted(),
      _meta: {}
    }))
    const { result } = renderHook(() => useLoadedChecks(pr))
    await waitFor(() => expect(result.current.comments).toEqual(freshComments))
    expect(result.current.repo).toBe(selected)
    const inline = result.current.comments.find((comment) => comment.id === inlineComment.id)
    const parent = result.current.comments.find((comment) => comment.id === conversation.id)
    if (!inline || !parent) {
      throw new Error('Missing freshly loaded manual reply targets')
    }
    await act(async () => {
      const nested = await result.current.handleReplyToComment(inline, 'Manual nested reply')
      const reaction = await result.current.handleSetReaction(inline, 'heart', true)
      const reply = await result.current.handleReplyToComment(parent, 'Manual conversation reply')
      const added = await result.current.handleAddPRComment('New comment')
      expect([nested, reaction, reply, added]).toEqual([
        { ok: true },
        true,
        { ok: true },
        { ok: true }
      ])
    })
    const selectedComments = useAppStore.getState().commentsCache[key(selected)]?.data
    expect(selectedComments?.map((comment) => comment.id)).toEqual([41, 42, 91, 92, 93])
    expect(selectedComments?.find((comment) => comment.id === 91)).toMatchObject({
      threadId: inline.threadId,
      path: inline.path,
      line: inline.line
    })
    expect(selectedComments?.find((comment) => comment.id === 42)?.reactions).toEqual([
      { content: 'heart', count: 1, viewerHasReacted: true }
    ])
    expect(useAppStore.getState().commentsCache[key(foreign)]).toBe(foreignEntry)
    expect(result.current.comments.map((comment) => comment.id)).toEqual([41, 42, 91, 92, 93])
    if (selectedLocal) {
      expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
      expect(mockApi.gh.addPRReviewCommentReply).toHaveBeenCalledWith(
        expect.objectContaining({ repoOwnerExecutionHostId: 'local' })
      )
      expect(mockApi.gh.setPRCommentReaction).toHaveBeenCalledWith(
        expect.objectContaining({ repoOwnerExecutionHostId: 'local' })
      )
      expect(mockApi.gh.addIssueComment).toHaveBeenCalledTimes(2)
      for (const call of mockApi.gh.addIssueComment.mock.calls) {
        expect(call[0]).toMatchObject({ repoOwnerExecutionHostId: 'local' })
      }
    } else {
      expect(mockApi.gh.addPRReviewCommentReply).not.toHaveBeenCalled()
      expect(mockApi.gh.setPRCommentReaction).not.toHaveBeenCalled()
      expect(mockApi.gh.addIssueComment).not.toHaveBeenCalled()
      expect(runtimeEnvironmentCall.mock.calls.map(([args]) => args.method)).toEqual([
        'github.prComments',
        'github.addPRReviewCommentReply',
        'github.setPRCommentReaction',
        'github.addIssueComment',
        'github.addIssueComment'
      ])
      for (const [args] of runtimeEnvironmentCall.mock.calls) {
        expect(args).toMatchObject({ selector: 'self' })
      }
    }
  }
)

it.each([false, true])(
  'keeps loaded, forced, and delayed conversation acknowledgement on the selected owner after navigation (runtime first: %s)',
  async (runtimeFirst) => {
    const { remoteRepo, localRepo, localEntry } = await catalog(false, runtimeFirst)
    const newReview = makePR({ number: 99, prRepo: pr.prRepo })
    const nextComments = [{ ...conversation, id: 99, body: 'New review' }]
    const post = Promise.withResolvers<{
      id: string
      ok: true
      result: { ok: true; comment: PRComment }
      _meta: {}
    }>()
    runtimeEnvironmentCall.mockImplementation(async (args) => {
      if (args.method === 'github.addIssueComment') {
        return post.promise
      }
      return {
        id: 'rpc-read',
        ok: true,
        result: args.params?.prNumber === 99 ? nextComments : [conversation],
        _meta: {}
      }
    })
    const { result, rerender } = renderHook(({ review }) => useLoadedChecks(review), {
      initialProps: { review: pr }
    })
    await waitFor(() => expect(result.current.selectableGroups).toHaveLength(1))
    expect(result.current.repo).toBe(remoteRepo)
    await act(async () => result.current.fetchComments({ force: true }))
    expect(
      runtimeEnvironmentCall.mock.calls.filter(([args]) => args.method === 'github.prComments')
    ).toHaveLength(2)
    act(() =>
      result.current.toggleGroupSelection(
        getPRCommentGroupId(result.current.selectableGroups[0]),
        true
      )
    )
    act(() => result.current.handleResolveCommentsWithAI(result.current.selectedGroups))
    await waitFor(() => expect(result.current.composer).not.toBeNull())
    const composer = result.current.composer
    const launch = composer?.launchContext
    if (!launch?.onLaunchAccepted || !launch.onLaunched) {
      throw new Error('Missing real delivery callbacks')
    }
    expect(composer?.commentResolution?.githubTarget).toMatchObject({
      repoOwnerExecutionHostId: 'runtime:self',
      prNumber: 12
    })
    rerender({ review: newReview })
    await waitFor(() => expect(result.current.comments).toEqual(nextComments))
    act(() => {
      launch.onLaunchAccepted?.()
      launch.onLaunched?.()
    })
    await waitFor(() =>
      expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
        expect.objectContaining({
          selector: 'self',
          method: 'github.addIssueComment',
          params: expect.objectContaining({ number: 12, repo: registeredRepo.id })
        })
      )
    )
    expect(result.current.busy).toBe(true)
    await act(async () => {
      post.resolve({
        id: 'rpc-post',
        ok: true,
        result: { ok: true, comment: postedComment },
        _meta: {}
      })
    })
    await waitFor(() => expect(result.current.busy).toBe(false))
    expect(
      useAppStore.getState().commentsCache[key(remoteRepo)]?.data?.map((comment) => comment.id)
    ).toEqual([41, 91])
    expect(useAppStore.getState().commentsCache[key(localRepo)]).toBe(localEntry)
    expect(result.current.comments).toEqual(nextComments)
    expect(mockApi.gh.prComments).not.toHaveBeenCalled()
    expect(mockApi.gh.addIssueComment).not.toHaveBeenCalled()
    expect(mockApi.gh.addPRReviewCommentReply).not.toHaveBeenCalled()
  }
)

it('reads initial and forced comments through the runtime credential owner behind nested SSH', async () => {
  const { remoteRepo } = await catalog(true)
  runtimeEnvironmentCall.mockResolvedValue({
    id: 'rpc-read',
    ok: true,
    result: [conversation],
    _meta: {}
  })
  const { result } = renderHook(() => useLoadedChecks(pr))
  await waitFor(() => expect(result.current.comments).toEqual([conversation]))
  await act(async () => result.current.fetchComments({ force: true }))
  expect(runtimeEnvironmentCall.mock.calls.map(([args]) => args)).toEqual([
    expect.objectContaining({ selector: 'self', method: 'github.prComments' }),
    expect.objectContaining({ selector: 'self', method: 'github.prComments' })
  ])
  expect(useAppStore.getState().commentsCache[key(remoteRepo)]?.data).toEqual([conversation])
  expect(mockApi.gh.prComments).not.toHaveBeenCalled()
})

it.each([false, true])(
  'refuses actual manual handlers before local optimism or dispatch when their owner is unavailable (invalid host: %s)',
  async (invalidHost) => {
    await catalog()
    const freshComments = [conversation, inlineComment]
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-read',
      ok: true,
      result: freshComments,
      _meta: {}
    })
    const initialProps: { hostId: ExecutionHostId | undefined } = { hostId: undefined }
    const { result, rerender } = renderHook(({ hostId }) => useLoadedChecks(pr, hostId), {
      initialProps
    })
    await waitFor(() => expect(result.current.comments).toEqual(freshComments))
    const captured = result.current
    if (invalidHost) {
      rerender({ hostId: 'runtime:' })
    } else {
      act(() => useAppStore.setState({ repos: [] }))
    }
    await waitFor(() => expect(result.current.comments).toEqual([]))
    const callbacks = invalidHost ? result.current : captured
    const panelComments = result.current.comments
    const cache = useAppStore.getState().commentsCache
    vi.clearAllMocks()
    await act(async () => {
      await expect(
        callbacks.handleReplyToComment(inlineComment, 'Reply', { notifyOnFailure: false })
      ).resolves.toMatchObject({ ok: false })
      await expect(
        callbacks.handleReplyToComment(conversation, 'Reply', { notifyOnFailure: false })
      ).resolves.toMatchObject({ ok: false })
      await expect(callbacks.handleAddPRComment('New comment')).resolves.toMatchObject({
        ok: false
      })
      await expect(callbacks.handleSetReaction(inlineComment, 'heart', true)).resolves.toBe(false)
    })
    expect(result.current.comments).toBe(panelComments)
    expect(useAppStore.getState().commentsCache).toBe(cache)
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(mockApi.gh.addPRReviewCommentReply).not.toHaveBeenCalled()
    expect(mockApi.gh.addIssueComment).not.toHaveBeenCalled()
    expect(mockApi.gh.setPRCommentReaction).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledTimes(2)
    expect(toast.error).toHaveBeenCalledWith(
      'The machine that owns this repository is not known yet. Reconnect it and try again.'
    )
  }
)

it('reports failed manual writes globally after navigation while limiting reaction rollback to the captured cache', async () => {
  const { localRepo, remoteRepo, localEntry } = await catalog()
  const freshComments = [conversation, inlineComment]
  const nextComments = [{ ...conversation, id: 99, body: 'New review' }]
  const replies = Promise.withResolvers<{
    id: string
    ok: true
    result: { ok: false; error: string }
    _meta: {}
  }>()
  const reaction = Promise.withResolvers<{ id: string; ok: true; result: boolean; _meta: {} }>()
  runtimeEnvironmentCall.mockImplementation(async (args) => {
    if (args.method === 'github.setPRCommentReaction') {
      return reaction.promise
    }
    if (
      args.method === 'github.addPRReviewCommentReply' ||
      args.method === 'github.addIssueComment'
    ) {
      return replies.promise
    }
    return {
      id: 'rpc-read',
      ok: true,
      result: args.params?.prNumber === 99 ? nextComments : freshComments,
      _meta: {}
    }
  })
  const { result, rerender } = renderHook(({ review }) => useLoadedChecks(review), {
    initialProps: { review: pr }
  })
  await waitFor(() => expect(result.current.comments).toEqual(freshComments))
  let pending: Promise<unknown> = Promise.resolve()
  act(() => {
    pending = Promise.all([
      result.current.handleReplyToComment(inlineComment, 'Nested reply'),
      result.current.handleReplyToComment(conversation, 'Conversation reply'),
      result.current.handleAddPRComment('New comment'),
      result.current.handleSetReaction(inlineComment, 'heart', true)
    ])
  })
  expect(result.current.comments.find((comment) => comment.id === 42)?.reactions).toEqual([
    { content: 'heart', count: 1, viewerHasReacted: true }
  ])
  rerender({ review: makePR({ number: 99, prRepo: pr.prRepo }) })
  await waitFor(() => expect(result.current.comments).toEqual(nextComments))
  await act(async () => {
    replies.resolve({
      id: 'rpc-post',
      ok: true,
      result: { ok: false, error: 'Host refused write' },
      _meta: {}
    })
    reaction.resolve({ id: 'rpc-reaction', ok: true, result: false, _meta: {} })
    await pending
  })
  expect(toast.error).toHaveBeenCalledTimes(4)
  expect(result.current.comments).toEqual(nextComments)
  expect(
    useAppStore
      .getState()
      .commentsCache[key(remoteRepo)]?.data?.find((comment) => comment.id === 42)?.reactions
  ).toBeUndefined()
  expect(useAppStore.getState().commentsCache[key(localRepo)]).toBe(localEntry)
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
