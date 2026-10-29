import type {
  GitHubTaskObservation,
  GitHubTaskFamily,
  GitHubTaskValueOrigin
} from '@/lib/github-task-observation'
import type { GitHubAssignableUser } from '../../../../../shared/github/pull-request-types'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'

export type TaskPageGitHubListFamily = 'assignees' | 'reviewRequests'
export type TaskPageGitHubMutationKey = {
  sourceScope: string | null
  observation?: GitHubTaskObservation
  repoId: string
  itemId: string
  itemType?: GitHubWorkItem['type']
  opKey: string
}
export type PendingListOp = {
  family: TaskPageGitHubListFamily
  kind: 'add' | 'remove'
  logins: string[]
  users?: GitHubAssignableUser[]
}
export type PendingOp = {
  generation: number
  key: TaskPageGitHubMutationKey
  previousOrigins?: Partial<Record<GitHubTaskFamily, GitHubTaskValueOrigin>>
  previous: Partial<GitHubWorkItem>
  next: Partial<GitHubWorkItem>
  listOp?: PendingListOp
  skipMeQualifiers: boolean
  startedAt: number
}
export type TaskPageGitHubMembershipBasis = {
  queryKey: string
  sourceScope: string | null
  observation?: GitHubTaskObservation
  repoId: string
  itemId: string
  rawItemId: string
  families: Partial<Record<GitHubTaskFamily, GitHubTaskValueOrigin>>
  skipMeQualifiers: boolean
}
