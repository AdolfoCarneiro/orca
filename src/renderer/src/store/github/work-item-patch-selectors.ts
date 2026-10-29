import { dependsOnTaskPageGitHubListRetirement } from '@/components/task-page/github/task-page-github-work-item-mutation-composition'
import {
  getLastConfirmedClientEntry,
  getLastConfirmedClientValue
} from '@/components/task-page/github/task-page-github-confirmed-client-values'
import { taskPageGitHubLastConfirmedKey } from '@/components/task-page/github/task-page-github-work-item-mutation-keys'

import type { ListComposition } from '@/components/task-page/github/task-page-github-work-item-mutation-registry'

import type { GitHubTaskFamily, GitHubTaskValueOrigin } from '@/lib/github-task-observation'

import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'

import type { GitHubPatchWorkItemOptions } from './cache-model'

import { parseGitHubIssueOrPRLink } from '../../../../shared/github/links'

import { githubRepoIdentityKey } from '../../../../shared/github/repository-identity-key'

import { repoCacheKeyHostId } from '../../../../shared/github/github-cache-key'

export type PatchRequest = {
  itemId: string
  patch: Partial<GitHubWorkItem>
  repoId?: string | null
  options?: GitHubPatchWorkItemOptions
}
export type PreparedPatch = PatchRequest & {
  order: number
  currentObservation: boolean
  sourceScope: string | null
  sourceScopes: readonly string[]
  repositoryKey: string | null
  fields: Map<string, { order: number; value: unknown }>
  lists: {
    order: number
    family: 'assignees' | 'reviewRequests'
    plan?: ListComposition
    value?: GitHubWorkItem['assignees']
    origin?: GitHubTaskValueOrigin
    assigned?: boolean
    hasOrigin?: boolean
  }[]
  origins: Map<GitHubTaskFamily, { order: number; value: GitHubTaskValueOrigin | undefined }>
}
export function bucketMatchesPatch(key: string, request: PreparedPatch): boolean {
  const { repoId, options, sourceScope, sourceScopes, repositoryKey } = request
  if (options?.hostId && repoId && repoCacheKeyHostId(key, [repoId]) !== options.hostId) {
    return false
  }
  if (options?.hostId && !sourceScope && key.startsWith('github:')) {
    return false
  }
  return (
    !sourceScopes.length ||
    sourceScopes.some((scope) => key === scope || key.startsWith(`${scope}::`)) ||
    (!key.startsWith('github:') &&
      !!(repoId && options?.hostId && repositoryKey && options?.matches))
  )
}
export function rowMatchesPatch(item: GitHubWorkItem, request: PreparedPatch): boolean {
  if (
    !request.currentObservation &&
    !request.lists.some(
      (instruction) =>
        instruction.plan?.retirement &&
        dependsOnTaskPageGitHubListRetirement(item, instruction.plan.retirement)
    )
  ) {
    return false
  }
  if (
    (request.repoId && item.repoId !== request.repoId) ||
    (request.options?.matches ? !request.options.matches(item) : item.id !== request.itemId)
  ) {
    return false
  }
  const repository = request.repositoryKey ? parseGitHubIssueOrPRLink(item.url)?.slug : undefined
  return (
    !request.repositoryKey ||
    (!!repository && githubRepoIdentityKey(repository) === request.repositoryKey)
  )
}

export function inheritScalarOrigins(
  item: GitHubWorkItem,
  request: PreparedPatch,
  patch: Partial<GitHubWorkItem>,
  origins: Partial<Record<GitHubTaskFamily, GitHubTaskValueOrigin | undefined>>
): void {
  for (const family of ['state', 'autoMerge'] as const) {
    const value = family === 'state' ? patch.state : patch.autoMergeEnabled
    if (value === undefined || family in origins) {
      continue
    }
    const scalar = getLastConfirmedClientEntry(
      request.sourceScope,
      item.repoId,
      request.itemId,
      family
    )
    if (
      scalar &&
      getLastConfirmedClientValue(
        request.sourceScope,
        item.repoId,
        request.itemId,
        family,
        parseGitHubIssueOrPRLink(item.url)?.slug
      ) === value
    ) {
      origins[family] = {
        kind: 'scalar',
        owner: scalar.observation,
        coordinate: taskPageGitHubLastConfirmedKey(
          request.sourceScope,
          item.repoId,
          request.itemId,
          family
        )
      }
    }
  }
}
