import { getGitHubTaskObservation, type GitHubTaskObservation } from '@/lib/github-task-observation'

import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { GitHubOwnerRepo } from '../../../../../shared/github/pull-request-types'
import { parseGitHubIssueOrPRLink } from '../../../../../shared/github/links'
import { githubRepoIdentityKey } from '../../../../../shared/github/repository-identity-key'
import type {
  TaskPageGitHubListFamily,
  TaskPageGitHubMutationKey
} from './task-page-github-work-item-registry-types'

export function taskPageGitHubItemKey(repoId: string, itemId: string): string {
  return `${repoId}\0${itemId}`
}
export function serializeTaskPageGitHubMutationKey(key: TaskPageGitHubMutationKey): string {
  const raw = `${key.sourceScope ?? ''}\0${key.repoId}\0${key.itemId}\0${key.opKey}`
  return key.itemType === 'issue' && key.observation
    ? JSON.stringify([raw, key.observation.key])
    : raw
}
export function taskPageGitHubSnapshotKey(
  sourceScope: string | null,
  repoId: string,
  itemId: string,
  family: TaskPageGitHubListFamily
): string {
  return `${sourceScope ?? ''}\0${repoId}\0${itemId}\0${family}`
}
export function taskPageGitHubLastConfirmedKey(
  sourceScope: string | null,
  repoId: string,
  itemId: string,
  family: string
): string {
  return `${sourceScope ?? ''}\0${repoId}\0${itemId}\0${family}`
}
export function taskPageGitHubFamilyDirtyKey(itemKey: string, family: string): string {
  return `${itemKey}\0${family}`
}
export function taskPageGitHubListOpKey(
  family: TaskPageGitHubListFamily,
  logins: readonly string[]
): string {
  const normalized = logins.map((login) => login.toLowerCase()).sort()
  if (normalized.length === 1) {
    return `${family}:${normalized[0]}`
  }
  return `${family}:batch:${normalized.join(',')}`
}

export function taskPageGitHubQualifiedMutationId(
  id: string,
  ownerRepo?: GitHubOwnerRepo | null
): string {
  return ownerRepo ? `${id}\u0001${githubRepoIdentityKey(ownerRepo)}` : id
}
export function taskPageGitHubMutationItemId(item: GitHubWorkItem): string {
  return item.type === 'issue'
    ? taskPageGitHubQualifiedMutationId(
        `issue:${item.number}`,
        parseGitHubIssueOrPRLink(item.url)?.slug
      )
    : item.id
}

export function taskPageGitHubMutationItemKey(item: GitHubWorkItem): string {
  return taskPageGitHubItemKey(item.repoId, taskPageGitHubMutationItemId(item))
}
export function taskPageGitHubAuthorityItemKeys(item: GitHubWorkItem): string[] {
  return taskPageGitHubAuthorityKeysForObservation(item, getGitHubTaskObservation(item))
}
export function taskPageGitHubAuthorityKeysForObservation(
  item: GitHubWorkItem,
  owner: GitHubTaskObservation | undefined
): string[] {
  const associations = owner?.associations ?? [{ scope: null, key: undefined }]
  return associations.flatMap(({ scope, key }) =>
    [item.id, taskPageGitHubMutationItemId(item)].flatMap((id) => [
      taskPageGitHubOwnedItemKey(scope, item.repoId, id, key),
      taskPageGitHubOwnedItemKey(null, item.repoId, id, key)
    ])
  )
}

export function taskPageGitHubOwnedItemKey(
  sourceScope: string | null,
  repoId: string,
  itemId: string,
  observationKey?: string
): string {
  return JSON.stringify([sourceScope, observationKey ?? null, repoId, itemId])
}
