// @vitest-environment happy-dom
import { useRef, useState } from 'react'
import { act, cleanup, renderHook, render, fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type { PRComment } from '../../../../../shared/github/comment-types'
import { groupPRComments } from '../../../../../shared/pr-comment-groups'
import { githubReviewThreadRequest } from '@/store/github/review-thread-request'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks
} from '@/store/slices/github-slice-test-harness'
import { ResolveButton } from './comment-controls'
import { useChecksPanelCommentResolution } from './use-checks-panel-comment-resolution'
import { useChecksPanelAiAcknowledgement } from './use-checks-panel-ai-acknowledgement'
import {
  clearPRCommentsListSelectionsForTests,
  seedPRCommentsListSelectionForTests,
  usePRCommentsListSelection,
  type PRCommentsListSelectionClearRequest
} from '../pr-comments-list-selection'
import type { PendingPRCommentAiAck } from '../pr-comments-ai-launch-ack'

vi.mock('@/components/tab-bar/use-new-tab-agent-menu-rows', () => ({
  useAgentMenuObservation: () => ({ preferencesPending: true })
}))
vi.mock('@/hooks/useAgentDetectionTarget', () => ({
  useAgentDetectionTargetForWorktree: () => null
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }))
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const repo = { id: 'ai-overlap', path: '/repo', displayName: 'Repo', badgeColor: '', addedAt: 0 }
const reviewContextKey = 'review::head'
const comment: PRComment = {
  id: 1,
  threadId: 'A',
  path: 'a.ts',
  isResolved: false,
  author: 'reviewer',
  authorAvatarUrl: '',
  body: 'Review',
  url: '',
  createdAt: ''
}
const other: PRComment = { ...comment, id: 2, threadId: 'B' }
type Model = Parameters<typeof useChecksPanelAiAcknowledgement>[0]

beforeEach(() => {
  vi.clearAllMocks()
  resetRemoteRuntimeMocks()
  mockApi.gh.resolveReviewThread.mockReset()
  clearPRCommentsListSelectionsForTests()
})
afterEach(cleanup)

function setup(comments = [comment, other]) {
  const store = createTestStore()
  store.setState({ repos: [repo] })
  const request = githubReviewThreadRequest(store.getState(), repo.path, 12, 'A', {
    repoId: repo.id
  })
  const fetchComments = vi.fn<Model['fetchComments']>().mockResolvedValue(undefined)
  const fetchGitLabDetails = vi.fn<Model['fetchGitLabDetails']>().mockResolvedValue(undefined)
  seedPRCommentsListSelectionForTests(reviewContextKey, ['thread:A'])
  const hook = renderHook(() => {
    const [rows, setComments] = useState(comments)
    const [clearRequest, setCommentsSelectionClearRequest] =
      useState<PRCommentsListSelectionClearRequest | null>(null)
    const selection = usePRCommentsListSelection(
      rows,
      reviewContextKey,
      clearRequest,
      (threadId) =>
        githubReviewThreadRequest(store.getState(), repo.path, 12, threadId, { repoId: repo.id })
          .key
    )
    const ack = useChecksPanelAiAcknowledgement({
      addPRConversationComment: store.getState().addPRConversationComment,
      addPRReviewCommentReply: store.getState().addPRReviewCommentReply,
      asyncResultKeyRef: useRef(reviewContextKey),
      claimedCommentResolutionRef: useRef(null),
      commentsRef: useRef(rows),
      commentsSelectionClearTokenRef: useRef(0),
      pendingCommentResolutionRef: useRef(null),
      resolveReviewThread: store.getState().resolveReviewThread,
      setCommentResolutionAckBusyNow: vi.fn(),
      setComments,
      setCommentsSelectionClearRequest,
      commentResolutionLaunchAcceptedRef: useRef(false),
      fetchComments,
      fetchGitLabDetails
    })
    const manual = useChecksPanelCommentResolution({
      activeWorktree: null,
      activeWorktreeId: null,
      claimedCommentResolutionRef: useRef(null),
      commentResolutionAckBusy: false,
      commentsLoading: false,
      detectedAgentIds: null,
      pendingCommentResolutionRef: useRef(null),
      repo,
      resolveReviewThread: store.getState().resolveReviewThread,
      setAgentComposerState: () => {},
      setComments,
      settings: store.getState().settings,
      commentResolutionLaunchAcceptedRef: useRef(false),
      activeGitLabReview: null,
      activeReview: null,
      pr: null,
      prNumber: 12,
      sourceControlAiActionsVisible: false
    })
    return { ack, selection, setComments, manual }
  })
  const resolution: PendingPRCommentAiAck = {
    reviewContextKey,
    provider: 'github',
    selectedGroups: groupPRComments([comment]),
    githubResolveTarget: { repoPath: repo.path, repoId: repo.id, prNumber: 12 },
    githubThreadRequests: new Map([['A', request]])
  }
  return { hook, resolution, store, request, fetchComments, fetchGitLabDetails }
}

it('keeps a busy-only acknowledgement neutral and allows manual retry after false settlement', async () => {
  const { hook, resolution, request, fetchComments } = setup()
  const host = Promise.withResolvers<boolean>()
  mockApi.gh.resolveReviewThread.mockReturnValueOnce(host.promise)
  let manual: Promise<boolean> | undefined
  act(() => {
    manual = hook.result.current.manual.handleResolve('A', true, { notifyOnFailure: false })
  })
  expect(hook.result.current.selection.selectedGroupIds).toEqual(new Set(['thread:A']))
  await act(async () => {
    await hook.result.current.ack.resolveSelectedThreadsAfterLaunch(resolution)
  })
  expect(mockApi.gh.resolveReviewThread).toHaveBeenCalledTimes(1)
  expect(toast.success).not.toHaveBeenCalled()
  expect(toast.error).not.toHaveBeenCalled()
  expect(fetchComments).not.toHaveBeenCalled()
  expect(toast.message).toHaveBeenCalledWith(
    expect.stringContaining('Selected threads still updating: 1')
  )
  act(() => hook.result.current.selection.toggleGroupSelection('thread:B', true))
  expect(hook.result.current.selection.selectedGroupIds).toEqual(new Set(['thread:B']))
  await act(async () => {
    host.resolve(false)
    await manual
  })
  expect(hook.result.current.selection.selectedGroupIds).toEqual(new Set(['thread:B']))
  mockApi.gh.resolveReviewThread.mockResolvedValueOnce(true)
  render(
    <ResolveButton
      threadId="A"
      isResolved={false}
      pendingKey={request.key}
      onResolve={hook.result.current.manual.handleResolve}
    />
  )
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Resolve' }))
  })
  expect(mockApi.gh.resolveReviewThread).toHaveBeenCalledTimes(2)
})

it('preserves a new selection made while a previous acknowledgement waits', async () => {
  const { hook, resolution } = setup()
  const host = Promise.withResolvers<boolean>()
  mockApi.gh.resolveReviewThread.mockReturnValueOnce(host.promise)
  let completion: Promise<void> | undefined
  act(() => {
    completion = hook.result.current.ack.resolveSelectedThreadsAfterLaunch(resolution)
  })
  expect(hook.result.current.selection.selectedGroupIds.size).toBe(0)
  act(() => hook.result.current.selection.toggleGroupSelection('thread:B', true))
  await act(async () => {
    host.resolve(false)
    await completion
  })
  expect(hook.result.current.selection.selectedGroupIds).toEqual(new Set(['thread:B']))
})
