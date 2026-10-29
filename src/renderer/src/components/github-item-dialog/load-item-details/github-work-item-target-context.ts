import { useAppStore } from '@/store'
import { prepareGitHubWorkItemTargetRequest } from '@/lib/github-work-item-target-request'
import {
  canUseGitHubRepoContext,
  getGitHubRepoRoutingTarget
} from '@/lib/github-source-runtime-context'
import {
  resolvePullRequestRepo,
  parseOwnerRepoFromItemUrl
} from '@/components/github/github-work-item-identity'
import { getTaskSourceCacheScope } from '../../../../../shared/task-source-context'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { GitHubItemDialogProjectOrigin } from './github-item-dialog-types'
import {
  getWorkItemDetailsCacheKey,
  invalidateWorkItemDetailsCacheForKey,
  touchWorkItemDetailsCache
} from './work-item-details-cache'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import { createContext, useContext, useMemo } from 'react'
import {
  GitHubWorkItemTargetError,
  type GitHubWorkItemTarget
} from '../../../../../shared/github/work-item-target'
import type { GitHubOwnerRepo } from '../../../../../shared/github/pull-request-types'

export const GitHubWorkItemTargetContext = createContext<{
  resource: GitHubWorkItemTarget
  target: RuntimeClientTarget
  sourceContext?: TaskSourceContext | null
  prepare: () => Promise<{ ownerRepo?: GitHubOwnerRepo }>
  reportError: (message: string) => boolean
} | null>(null)

export function useGitHubWorkItemTarget() {
  return useContext(GitHubWorkItemTargetContext)
}

export function useGitHubItemTargetIdentity({
  workItem,
  repoPath,
  effectiveRepoId,
  sourceContext,
  projectOrigin
}: {
  workItem: GitHubWorkItem | null
  repoPath: string | null
  effectiveRepoId: string | null
  sourceContext?: TaskSourceContext | null
  projectOrigin?: GitHubItemDialogProjectOrigin
}) {
  // Include source preference so origin/upstream switches cannot reuse details from the wrong repository.
  const issueSourcePreference = useAppStore((s) => {
    if (!repoPath && !effectiveRepoId) {
      return undefined
    }
    return s.repos.find((r) => (effectiveRepoId ? r.id === effectiveRepoId : r.path === repoPath))
      ?.issueSourcePreference
  })
  const canUseDetailsRepoContext = canUseGitHubRepoContext(repoPath, sourceContext)
  const repository = useMemo(
    () =>
      workItem
        ? workItem.type === 'pr'
          ? resolvePullRequestRepo(workItem, projectOrigin)
          : (projectOrigin ?? parseOwnerRepoFromItemUrl(workItem.url))
        : null,
    [projectOrigin, workItem]
  )
  const resource = useMemo(
    () =>
      workItem && repository
        ? { repository: repository, type: workItem.type, number: workItem.number }
        : null,
    [workItem, repository]
  )
  const detailsCacheKey = useMemo(() => {
    if (!workItem || !effectiveRepoId || !canUseDetailsRepoContext) {
      return null
    }
    return getWorkItemDetailsCacheKey({
      repoPath: repoPath ?? '',
      repoId: effectiveRepoId,
      issueSourcePreference,
      sourceContext,
      sourceCacheScope:
        sourceContext?.provider === 'github' ? getTaskSourceCacheScope(sourceContext) : null,
      type: workItem.type,
      number: workItem.number,
      ownerRepo: repository
    })
  }, [
    canUseDetailsRepoContext,
    repoPath,
    effectiveRepoId,
    sourceContext,
    workItem,
    issueSourcePreference,
    repository
  ])

  return { resource, detailsCacheKey, canUseDetailsRepoContext }
}

export function useGitHubItemTargetContext({
  resource,
  effectiveRepoId,
  repoPath,
  sourceContext,
  detailsCacheKey
}: {
  resource: GitHubWorkItemTarget | null
  effectiveRepoId: string | null
  repoPath: string | null
  sourceContext?: TaskSourceContext | null
  detailsCacheKey: string | null
}) {
  return useMemo(() => {
    if (!resource || !effectiveRepoId) {
      return null
    }
    const target = getGitHubRepoRoutingTarget(
      useAppStore.getState(),
      effectiveRepoId,
      sourceContext
    )
    return {
      resource,
      target,
      sourceContext,
      prepare: () =>
        prepareGitHubWorkItemTargetRequest({
          resource,
          target,
          repoPath,
          repoId: effectiveRepoId,
          sourceContext
        }),
      reportError: (message: string) => {
        if (message !== new GitHubWorkItemTargetError(resource).message) {
          return false
        }
        if (detailsCacheKey) {
          invalidateWorkItemDetailsCacheForKey(detailsCacheKey)
          touchWorkItemDetailsCache(detailsCacheKey, {
            details: null,
            fetchedAt: 0,
            error: message
          })
        }
        return true
      }
    }
  }, [resource, effectiveRepoId, repoPath, sourceContext, detailsCacheKey])
}
