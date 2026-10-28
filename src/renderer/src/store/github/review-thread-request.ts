import type { AppState } from '../types'
import type { GitHubOwnerRepo } from '../../../../shared/github/pull-request-types'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import type { ReviewThreadResolutionOwner } from '@/lib/review-thread-resolution-pending'
import type { RepoScopedFetchOptions } from './cache-model'
import { prCommentsCacheSuffix, sourceScopedRepoCacheKey } from './cache-identity'
import {
  getGitHubRepoSourceSettings,
  getGitHubSourceTarget,
  getGitHubWorkItemRequestContext,
  getGitHubWorkItemSourceHostId
} from './work-item-routing'

export type GitHubReviewThreadRequest = {
  key: string
  cacheKey: string
  repoPath: string
  repoId: string | undefined
  prNumber: number
  threadId: string
  prRepo: GitHubOwnerRepo | null | undefined
  sourceContext: TaskSourceContext | null | undefined
  target: ReturnType<typeof getGitHubWorkItemRequestContext>['target']
}

export type GitHubReviewThreadAdmission = {
  owner: ReviewThreadResolutionOwner
  request: GitHubReviewThreadRequest
}

export function githubReviewThreadRequest(
  state: AppState,
  repoPath: string,
  prNumber: number,
  threadId: string,
  options?: RepoScopedFetchOptions & { prRepo?: GitHubOwnerRepo | null }
): GitHubReviewThreadRequest {
  const repo = state.repos?.find((candidate) =>
    options?.repoId ? candidate.id === options.repoId : candidate.path === repoPath
  )
  const repoId = options?.repoId ?? repo?.id
  const settings = getGitHubRepoSourceSettings(state, repo, options?.sourceContext)
  const cacheKey = sourceScopedRepoCacheKey(
    repoPath,
    repoId,
    prCommentsCacheSuffix(prNumber, options?.prRepo),
    settings,
    repo?.connectionId,
    repo?.executionHostId,
    options?.sourceContext,
    repo !== undefined
  )
  const context = getGitHubWorkItemRequestContext(
    state,
    getGitHubSourceTarget(state, repo, options?.sourceContext),
    repoId ?? repoPath,
    repoPath,
    options?.sourceContext
  )
  const dispatchRepo =
    context.target.kind === 'environment' ? context.target.runtimeRepoId : (repoId ?? repoPath)
  const endpoint =
    context.target.kind === 'environment'
      ? ['environment', context.target.environmentId]
      : ['local', getGitHubWorkItemSourceHostId(repo, options?.sourceContext) ?? 'local']
  // Missing PR metadata can infer Enterprise origin; host metadata cannot split admission.
  return {
    key: JSON.stringify(['github', endpoint, dispatchRepo, prNumber, threadId]),
    cacheKey,
    repoPath,
    repoId,
    prNumber,
    threadId,
    prRepo: options?.prRepo ? { ...options.prRepo } : options?.prRepo,
    sourceContext: options?.sourceContext ? { ...options.sourceContext } : options?.sourceContext,
    target: context.target
  }
}
