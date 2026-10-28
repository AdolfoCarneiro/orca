import type { GitLabDiscussionResolveResult } from '../../../shared/gitlab-types'
import { authorityKey, parseHostAuthorityKey } from '../../../shared/host-authority'
import type { ForgeRepoSelector } from './forge-credential-target'
import { gitLabApiFor } from './gitlab-owner-api'
import {
  acquireReviewThreadResolution,
  adoptReviewThreadResolution,
  releaseReviewThreadResolution,
  type ReviewThreadResolutionOwner
} from '@/lib/review-thread-resolution-pending'

export type GitLabReviewThreadRequest = ReturnType<typeof gitlabReviewThreadRequest>
export type GitLabReviewThreadAdmission = {
  request: GitLabReviewThreadRequest
  owner: ReviewThreadResolutionOwner
}

export function gitlabReviewThreadRequest(
  selector: ForgeRepoSelector,
  iid: number,
  discussionId: string
) {
  const captured = {
    ...selector,
    sourceContext: selector.sourceContext ? { ...selector.sourceContext } : selector.sourceContext
  }
  const hostId = captured.sourceContext?.hostId || captured.repoOwnerExecutionHostId || 'local'
  const authority = parseHostAuthorityKey(hostId)
  const endpoint =
    authority?.endpoint.kind === 'environment'
      ? ['environment', authority.endpoint.environmentId]
      : ['local', authority ? authorityKey(authority) : hostId]
  const dispatchRepo =
    authority?.endpoint.kind === 'environment'
      ? captured.sourceContext?.repoId?.trim() || captured.repoId?.trim() || captured.repoPath
      : captured.repoId?.trim() ||
        (captured.sourceContext?.provider === 'gitlab' && captured.sourceContext.repoId?.trim()) ||
        captured.repoPath
  return {
    key: JSON.stringify(['gitlab', endpoint, dispatchRepo, iid, discussionId]),
    selector: captured,
    iid,
    discussionId
  }
}

export async function resolveGitlabReviewThread(
  request: GitLabReviewThreadRequest,
  resolved: boolean,
  adoptedOwner?: ReviewThreadResolutionOwner
): Promise<GitLabDiscussionResolveResult | 'busy'> {
  const owner = adoptedOwner ?? acquireReviewThreadResolution(request.key)
  if (!owner || !adoptReviewThreadResolution(request.key, owner)) {
    return 'busy'
  }
  try {
    return await gitLabApiFor(request.selector).resolveMRDiscussion({
      ...request.selector,
      iid: request.iid,
      discussionId: request.discussionId,
      resolved
    })
  } finally {
    if (!adoptedOwner) {
      releaseReviewThreadResolution(owner)
    }
  }
}
