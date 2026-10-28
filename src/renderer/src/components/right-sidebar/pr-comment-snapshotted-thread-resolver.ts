import {
  acquireReviewThreadResolution,
  releaseReviewThreadResolution,
  type ReviewThreadResolutionResult
} from '@/lib/review-thread-resolution-pending'
import {
  gitlabReviewThreadRequest,
  type GitLabReviewThreadAdmission
} from '@/runtime/review-thread-resolution'
import type {
  GitHubReviewThreadAdmission,
  GitHubReviewThreadRequest
} from '@/store/github/review-thread-request'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import type {
  PendingPRCommentAiAckGithubResolveTarget,
  PendingPRCommentAiAckGitlabTarget
} from './pr-comments-ai-launch-ack'

/** Host outcome shape; GitLab reports a message, GitHub only reports success. */
export type SnapshottedThreadResolveOutcome = { ok: boolean; error?: string }

export type SnapshottedThreadResolverDeps = {
  provider: HostedReviewInfo['provider']
  githubResolveTarget?: PendingPRCommentAiAckGithubResolveTarget
  gitlabTarget?: PendingPRCommentAiAckGitlabTarget
  githubThreadRequests?: ReadonlyMap<string, GitHubReviewThreadRequest>
  resolveReviewThread: (
    repoPath: string,
    prNumber: number,
    threadId: string,
    resolve: boolean,
    options: {
      repoId: string
      prRepo?: PendingPRCommentAiAckGithubResolveTarget['prRepo']
      threadResolutionAdmission?: GitHubReviewThreadAdmission
    }
  ) => Promise<ReviewThreadResolutionResult>
  resolveGitLabDiscussion: (
    args: {
      repoPath: string
      repoId: string
      iid: number
      discussionId: string
      resolved: boolean
      repoOwnerExecutionHostId: string
    },
    admission?: GitLabReviewThreadAdmission
  ) => Promise<SnapshottedThreadResolveOutcome | 'busy'>
  /** False once the panel moved to another review: host calls continue, UI writes stop. */
  isPanelStillOnLaunchReview: () => boolean
  onResolvedOptimistically: (threadId: string) => void
  onResolveFailed: (args: { threadId: string; error?: string }) => void
}

/** Use the snapshotted launch review for host resolves even if the panel switches before prompt delivery. */
export function buildSnapshottedThreadResolver(
  deps: SnapshottedThreadResolverDeps
): (threadId: string) => Promise<ReviewThreadResolutionResult> {
  return async (threadId) => {
    const githubRequest =
      deps.provider === 'github' ? deps.githubThreadRequests?.get(threadId) : undefined
    const gitlabRequest =
      deps.provider === 'gitlab' && deps.gitlabTarget
        ? gitlabReviewThreadRequest(
            {
              repoPath: deps.gitlabTarget.repoPath,
              repoId: deps.gitlabTarget.repoId,
              repoOwnerExecutionHostId: deps.gitlabTarget.ownerHostId
            },
            deps.gitlabTarget.iid,
            threadId
          )
        : undefined
    const key = githubRequest?.key ?? gitlabRequest?.key
    if (!key) {
      deps.onResolveFailed({ threadId, error: undefined })
      return false
    }
    const owner = acquireReviewThreadResolution(key)
    if (!owner) {
      return 'busy'
    }
    try {
      let outcome: SnapshottedThreadResolveOutcome | 'busy'
      if (gitlabRequest && deps.gitlabTarget) {
        outcome = await deps.resolveGitLabDiscussion(
          {
            repoPath: deps.gitlabTarget.repoPath,
            repoId: deps.gitlabTarget.repoId,
            iid: deps.gitlabTarget.iid,
            discussionId: threadId,
            resolved: true,
            repoOwnerExecutionHostId: deps.gitlabTarget.ownerHostId
          },
          { request: gitlabRequest, owner }
        )
      } else if (githubRequest && deps.githubResolveTarget) {
        const target = deps.githubResolveTarget
        const result = await deps.resolveReviewThread(
          target.repoPath,
          target.prNumber,
          threadId,
          true,
          {
            repoId: target.repoId,
            prRepo: target.prRepo,
            threadResolutionAdmission: { owner, request: githubRequest }
          }
        )
        outcome = result === 'busy' ? 'busy' : { ok: result }
      } else {
        outcome = { ok: false }
      }
      if (outcome === 'busy') {
        return 'busy'
      }
      if (!outcome.ok) {
        deps.onResolveFailed({ threadId, error: outcome.error })
        return false
      }
      if (deps.isPanelStillOnLaunchReview()) {
        deps.onResolvedOptimistically(threadId)
      }
      return true
    } catch (error) {
      deps.onResolveFailed({
        threadId,
        error: error instanceof Error ? error.message : String(error)
      })
      return false
    } finally {
      releaseReviewThreadResolution(owner)
    }
  }
}
