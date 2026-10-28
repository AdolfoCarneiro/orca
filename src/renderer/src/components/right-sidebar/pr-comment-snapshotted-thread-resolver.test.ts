import { createTestStore } from '@/store/slices/github-slice-test-harness'
import { githubReviewThreadRequest } from '@/store/github/review-thread-request'
import {
  acquireReviewThreadResolution,
  releaseReviewThreadResolution
} from '@/lib/review-thread-resolution-pending'
import { describe, expect, it, vi } from 'vitest'
import {
  buildSnapshottedThreadResolver,
  type SnapshottedThreadResolverDeps
} from './pr-comment-snapshotted-thread-resolver'

const PR_REPO = { owner: 'acme', repo: 'widgets', host: 'github.com' }

function deps(
  overrides: Partial<SnapshottedThreadResolverDeps> = {}
): SnapshottedThreadResolverDeps {
  const target: NonNullable<SnapshottedThreadResolverDeps['githubResolveTarget']> =
    overrides.githubResolveTarget ?? {
      repoPath: '/repos/widgets',
      repoId: 'repo-1',
      prNumber: 42
    }
  return {
    githubThreadRequests: new Map(
      ['T1'].map((threadId) => [
        threadId,
        githubReviewThreadRequest(
          createTestStore().getState(),
          target.repoPath,
          target.prNumber,
          threadId,
          { repoId: target.repoId, prRepo: target.prRepo }
        )
      ])
    ),
    provider: 'github',
    githubResolveTarget: { repoPath: '/repos/widgets', repoId: 'repo-1', prNumber: 42 },
    resolveReviewThread: vi.fn().mockResolvedValue(true),
    resolveGitLabDiscussion: vi.fn().mockResolvedValue({ ok: true }),
    isPanelStillOnLaunchReview: () => true,
    onResolvedOptimistically: vi.fn(),
    onResolveFailed: vi.fn(),
    ...overrides
  }
}

describe('buildSnapshottedThreadResolver', () => {
  it('resolves a GitHub thread against the snapshotted PR, passing prRepo when known', async () => {
    const resolveReviewThread = vi.fn().mockResolvedValue(true)
    const onResolvedOptimistically = vi.fn()
    const resolve = buildSnapshottedThreadResolver(
      deps({
        githubResolveTarget: {
          repoPath: '/repos/widgets',
          repoId: 'repo-1',
          prNumber: 42,
          prRepo: PR_REPO
        },
        resolveReviewThread,
        onResolvedOptimistically
      })
    )

    expect(await resolve('T1')).toBe(true)
    expect(resolveReviewThread).toHaveBeenCalledWith('/repos/widgets', 42, 'T1', true, {
      repoId: 'repo-1',
      prRepo: PR_REPO,
      threadResolutionAdmission: expect.objectContaining({
        owner: expect.any(Object),
        request: expect.objectContaining({ threadId: 'T1' })
      })
    })
    expect(onResolvedOptimistically).toHaveBeenCalledWith('T1')
  })

  // Why: resolveReviewThread takes prRepo as an option; a degraded PR entry must still resolve.
  it('resolves a GitHub thread when the snapshot has no prRepo', async () => {
    const resolveReviewThread = vi.fn().mockResolvedValue(true)
    const resolve = buildSnapshottedThreadResolver(deps({ resolveReviewThread }))

    expect(await resolve('T1')).toBe(true)
    expect(resolveReviewThread).toHaveBeenCalledWith('/repos/widgets', 42, 'T1', true, {
      repoId: 'repo-1',
      prRepo: undefined,
      threadResolutionAdmission: expect.objectContaining({ owner: expect.any(Object) })
    })
  })

  it('resolves a GitLab discussion against the snapshotted MR iid and host', async () => {
    const resolveGitLabDiscussion = vi.fn().mockResolvedValue({ ok: true })
    const resolveReviewThread = vi.fn()
    const resolve = buildSnapshottedThreadResolver(
      deps({
        provider: 'gitlab',
        githubResolveTarget: undefined,
        gitlabTarget: {
          repoPath: '/repos/widgets',
          repoId: 'repo-1',
          iid: 7,
          ownerHostId: 'runtime:env-b'
        },
        resolveGitLabDiscussion,
        resolveReviewThread
      })
    )

    expect(await resolve('D1')).toBe(true)
    expect(resolveGitLabDiscussion).toHaveBeenCalledWith(
      {
        repoPath: '/repos/widgets',
        repoId: 'repo-1',
        iid: 7,
        discussionId: 'D1',
        resolved: true,
        repoOwnerExecutionHostId: 'runtime:env-b'
      },
      expect.objectContaining({ owner: expect.any(Object) })
    )
    expect(resolveReviewThread).not.toHaveBeenCalled()
  })

  it('fails without calling a host when the provider cannot resolve threads', async () => {
    const resolveReviewThread = vi.fn()
    const resolveGitLabDiscussion = vi.fn()
    const onResolveFailed = vi.fn()
    const resolve = buildSnapshottedThreadResolver(
      deps({
        provider: 'bitbucket',
        githubResolveTarget: undefined,
        resolveReviewThread,
        resolveGitLabDiscussion,
        onResolveFailed
      })
    )

    expect(await resolve('T1')).toBe(false)
    expect(resolveReviewThread).not.toHaveBeenCalled()
    expect(resolveGitLabDiscussion).not.toHaveBeenCalled()
    expect(onResolveFailed).toHaveBeenCalledWith({ threadId: 'T1', error: undefined })
  })

  it('fails when the snapshotted target is missing', async () => {
    const resolveGithub = buildSnapshottedThreadResolver(deps({ githubResolveTarget: undefined }))
    const resolveGitlab = buildSnapshottedThreadResolver(
      deps({ provider: 'gitlab', githubResolveTarget: undefined, gitlabTarget: undefined })
    )

    expect(await resolveGithub('T1')).toBe(false)
    expect(await resolveGitlab('D1')).toBe(false)
  })

  it('surfaces the GitLab host error instead of swallowing it', async () => {
    const onResolveFailed = vi.fn()
    const onResolvedOptimistically = vi.fn()
    const resolve = buildSnapshottedThreadResolver(
      deps({
        provider: 'gitlab',
        githubResolveTarget: undefined,
        gitlabTarget: {
          repoPath: '/repos/widgets',
          repoId: 'repo-1',
          iid: 7,
          ownerHostId: 'runtime:env-b'
        },
        resolveGitLabDiscussion: vi.fn().mockResolvedValue({ ok: false, error: 'timed out' }),
        onResolveFailed,
        onResolvedOptimistically
      })
    )

    expect(await resolve('D1')).toBe(false)
    expect(onResolveFailed).toHaveBeenCalledWith({ threadId: 'D1', error: 'timed out' })
    expect(onResolvedOptimistically).not.toHaveBeenCalled()
  })

  it('reports a rejected host call as a failure', async () => {
    const onResolveFailed = vi.fn()
    const resolve = buildSnapshottedThreadResolver(
      deps({
        resolveReviewThread: vi.fn().mockRejectedValue(new Error('socket closed')),
        onResolveFailed
      })
    )

    expect(await resolve('T1')).toBe(false)
    expect(onResolveFailed).toHaveBeenCalledWith({ threadId: 'T1', error: 'socket closed' })
  })

  it('skips the optimistic update when the resolve failed', async () => {
    const onResolvedOptimistically = vi.fn()
    const resolve = buildSnapshottedThreadResolver(
      deps({
        resolveReviewThread: vi.fn().mockResolvedValue(false),
        onResolvedOptimistically
      })
    )

    expect(await resolve('T1')).toBe(false)
    expect(onResolvedOptimistically).not.toHaveBeenCalled()
  })

  // Host resolution retains its launch target; optimistic writes must not enter the newly selected review.
  it('still resolves on the host but skips the optimistic update after the panel moved', async () => {
    const resolveReviewThread = vi.fn().mockResolvedValue(true)
    const onResolvedOptimistically = vi.fn()
    const resolve = buildSnapshottedThreadResolver(
      deps({
        resolveReviewThread,
        isPanelStillOnLaunchReview: () => false,
        onResolvedOptimistically
      })
    )

    expect(await resolve('T1')).toBe(true)
    expect(resolveReviewThread).toHaveBeenCalledTimes(1)
    expect(onResolvedOptimistically).not.toHaveBeenCalled()
  })
})

it('treats a pending thread as neutral and keeps ownership through the optimistic completion', async () => {
  const model = deps()
  const request = model.githubThreadRequests?.get('T1')
  if (!request) {
    throw new Error('Missing test request')
  }
  const owner = acquireReviewThreadResolution(request.key)
  if (!owner) {
    throw new Error('Unexpected test owner')
  }
  const resolver = buildSnapshottedThreadResolver(model)
  try {
    expect(await resolver('T1')).toBe('busy')
    expect(model.resolveReviewThread).not.toHaveBeenCalled()
    expect(model.onResolveFailed).not.toHaveBeenCalled()
    expect(model.onResolvedOptimistically).not.toHaveBeenCalled()
  } finally {
    releaseReviewThreadResolution(owner)
  }
  model.onResolvedOptimistically = () => {
    expect(acquireReviewThreadResolution(request.key)).toBe(null)
  }
  expect(await resolver('T1')).toBe(true)
  const retry = acquireReviewThreadResolution(request.key)
  expect(retry).not.toBe(null)
  if (retry) {
    releaseReviewThreadResolution(retry)
  }
})
