// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { useState, type SetStateAction } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { PRComment } from '../../../../../shared/github/comment-types'
import type { PRInfo } from '../../../../../shared/github/pull-request-types'
import type { HostedReviewInfo } from '../../../../../shared/hosted-review'
import { getDefaultSettings } from '../../../../../shared/constants'
import { useMountedRef } from '@/hooks/useMountedRef'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import {
  checksPanelAsyncResultKey,
  checksPanelHostedReviewAsyncResultKey
} from '../checks-panel-async-result-key'
import { useChecksPanelCommentResolution } from './use-checks-panel-comment-resolution'

const resolveGitLab = vi.hoisted(() => vi.fn())
const toastError = vi.hoisted(() => vi.fn())
vi.mock('./gitlab-review-client', () => ({ resolveGitLabMRDiscussionForChecks: resolveGitLab }))
vi.mock('@/components/tab-bar/use-new-tab-agent-menu-rows', () => ({
  useAgentMenuObservation: () => ({ preferencesPending: false, preferences: {} })
}))
vi.mock('@/hooks/useAgentDetectionTarget', () => ({
  useAgentDetectionTargetForWorktree: () => undefined
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('sonner', () => ({ toast: { error: toastError } }))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const original: PRComment = {
  id: 10,
  author: 'reviewer',
  authorAvatarUrl: '',
  body: 'Old review',
  createdAt: '',
  url: '',
  threadId: 'old-thread',
  isResolved: false
}
const nextComment: PRComment = {
  ...original,
  body: 'Another source review',
  threadId: 'new-thread',
  isResolved: true
}
const initialReview: HostedReviewInfo = {
  provider: 'gitlab',
  number: 12,
  title: 'Review',
  state: 'open',
  url: '',
  status: 'pending',
  mergeable: 'MERGEABLE',
  updatedAt: '',
  headSha: 'old-head'
}
type PanelContext = {
  review: HostedReviewInfo
  cacheKey: string
  hostId: string
}
const initialContext: PanelContext = {
  review: initialReview,
  cacheKey: 'repo::main',
  hostId: 'local'
}

function fixture(context = initialContext) {
  const result = Promise.withResolvers<boolean>()
  resolveGitLab.mockImplementation(() =>
    result.promise.then((ok) => (ok ? { ok: true } : { ok: false, error: 'Request failed' }))
  )
  const resolveGitHub = vi.fn().mockReturnValue(result.promise)
  const commentWrites = vi.fn()
  const currentKey = { current: '' }
  const isCurrentAsyncResult = (key: string) => key === currentKey.current
  const view = renderHook(
    (panel: PanelContext) => {
      const [comments, setCommentState] = useState([original])
      const mountedRef = useMountedRef()
      const isGitLab = panel.review.provider === 'gitlab'
      const activeGitLabReview: (HostedReviewInfo & { provider: 'gitlab' }) | null = isGitLab
        ? { ...panel.review, provider: 'gitlab' }
        : null
      const pr: PRInfo | null = isGitLab
        ? null
        : {
            number: panel.review.number,
            title: panel.review.title,
            state: 'open',
            url: '',
            checksStatus: 'pending',
            mergeable: 'MERGEABLE',
            updatedAt: '',
            headSha: panel.review.headSha
          }
      currentKey.current = isGitLab
        ? checksPanelHostedReviewAsyncResultKey(
            panel.cacheKey,
            'main',
            panel.review.provider,
            panel.review.number,
            panel.review.headSha
          )
        : checksPanelAsyncResultKey(panel.cacheKey, 'main', pr?.number ?? null, null, pr?.headSha)
      const setComments = (value: SetStateAction<PRComment[]>) => {
        commentWrites(value)
        setCommentState(value)
      }
      const repo = {
        id: 'repo',
        path: '/repo',
        displayName: 'Repo',
        badgeColor: 'blue',
        addedAt: 0
      }
      const worktree = makeWorktree({
        id: 'repo::/repo',
        repoId: repo.id,
        hostId: panel.hostId
      })
      const model = {
        activeGitLabReview,
        activeReview: panel.review,
        activeWorktree: worktree,
        activeWorktreeId: worktree.id,
        branch: 'main',
        claimedCommentResolutionRef: { current: null },
        commentResolutionAckBusy: false,
        commentsLoading: false,
        detectedAgentIds: null,
        hostedReviewCacheKey: panel.cacheKey,
        isCurrentAsyncResult,
        mountedRef,
        pendingCommentResolutionRef: { current: null },
        pr,
        prCacheKey: panel.cacheKey,
        prNumber: pr?.number ?? null,
        repo,
        resolveReviewThread: resolveGitHub,
        setAgentComposerState: vi.fn(),
        setComments,
        settings: getDefaultSettings('/tmp/thread-resolution-owner'),
        sourceControlAiActionsVisible: true,
        commentResolutionLaunchAcceptedRef: { current: false }
      }
      return {
        ...useChecksPanelCommentResolution(model),
        comments,
        setComments,
        mountedRef
      }
    },
    { initialProps: context }
  )
  return { ...view, outcome: result, commentWrites, resolveGitHub }
}

it.each(['review', 'source'] as const)(
  'ignores a failed GitLab request after the panel changes %s',
  async (change) => {
    const f = fixture()
    let pending: Promise<boolean> | undefined
    act(() => {
      pending = f.result.current.handleResolve('old-thread', true)
    })
    expect(f.result.current.comments[0].isResolved).toBe(true)
    act(() => f.result.current.setComments([nextComment]))
    f.rerender({
      review: change === 'review' ? { ...initialReview, number: 13 } : initialReview,
      cacheKey: change === 'source' ? 'runtime:other::repo::main' : initialContext.cacheKey,
      hostId: change === 'source' ? 'runtime:other' : initialContext.hostId
    })
    f.commentWrites.mockClear()
    await act(async () => {
      f.outcome.resolve(false)
      await expect(pending).resolves.toBe(false)
    })
    expect(f.result.current.comments).toEqual([nextComment])
    expect(f.commentWrites).not.toHaveBeenCalled()
    expect(toastError).not.toHaveBeenCalled()
  }
)

it.each(['gitlab', 'github'] as const)(
  'does not publish a failed %s request after the panel unmounts',
  async (provider) => {
    const f = fixture({ ...initialContext, review: { ...initialReview, provider } })
    let pending: Promise<boolean> | undefined
    act(() => {
      pending = f.result.current.handleResolve('old-thread', true)
    })
    const mountedRef = f.result.current.mountedRef
    f.unmount()
    expect(mountedRef.current).toBe(false)
    f.commentWrites.mockClear()
    await act(async () => {
      f.outcome.resolve(false)
      await expect(pending).resolves.toBe(false)
    })
    expect(f.commentWrites).not.toHaveBeenCalled()
    expect(toastError).not.toHaveBeenCalled()
  }
)

it.each([true, false])(
  'rolls back a current GitLab failure with notifyOnFailure=%s',
  async (notify) => {
    const f = fixture()
    let pending: Promise<boolean> | undefined
    act(() => {
      pending = f.result.current.handleResolve('old-thread', true, { notifyOnFailure: notify })
    })
    expect(f.result.current.comments[0].isResolved).toBe(true)
    await act(async () => {
      f.outcome.resolve(false)
      await expect(pending).resolves.toBe(false)
    })
    expect(f.result.current.comments).toEqual([original])
    expect(toastError).toHaveBeenCalledTimes(notify ? 1 : 0)
  }
)

it('keeps a successful current resolution and routes it to the owning paired source', async () => {
  const f = fixture({ ...initialContext, hostId: 'runtime:owner' })
  let pending: Promise<boolean> | undefined
  act(() => {
    pending = f.result.current.handleResolve('old-thread', true)
  })
  expect(resolveGitLab).toHaveBeenCalledWith({
    repoPath: '/repo',
    repoId: 'repo',
    iid: 12,
    discussionId: 'old-thread',
    resolved: true,
    repoOwnerExecutionHostId: 'runtime:owner'
  })
  await act(async () => {
    f.outcome.resolve(true)
    await expect(pending).resolves.toBe(true)
  })
  expect(f.result.current.comments).toEqual([{ ...original, isResolved: true }])
  expect(toastError).not.toHaveBeenCalled()
})
