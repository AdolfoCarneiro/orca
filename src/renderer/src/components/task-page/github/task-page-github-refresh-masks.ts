import type { GitHubTaskObservation } from '@/lib/github-task-observation'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import type { GitHubAssignableUser } from '../../../../../shared/github/pull-request-types'
import { githubTaskSourceKey } from '@/lib/github-task-target'
import { parseGitHubIssueOrPRLink } from '../../../../../shared/github/links'
import { taskPageGitHubMutationItemId } from './task-page-github-work-item-mutation-keys'
import {
  createTaskPageGitHubScalarAuthorityIndex,
  deleteLastConfirmedClientValue
} from './task-page-github-confirmed-client-values'
import {
  getTaskPageGitHubMutationQueryKey,
  batchTaskPageGitHubMutationRegistry,
  getConfirmedListSnapshot,
  deleteConfirmedListSnapshot,
  notifyTaskPageGitHubMutationRegistry
} from './task-page-github-work-item-mutation-registry'
/** Only the exact completed masks observed before this read may be retired. */
export function captureTaskPageGitHubRefreshMasks(
  item: GitHubWorkItem,
  sources: readonly TaskSourceContext[],
  observations: readonly (GitHubTaskObservation | undefined)[] = []
) {
  const query = getTaskPageGitHubMutationQueryKey()
  const id = taskPageGitHubMutationItemId(item)
  const owner = parseGitHubIssueOrPRLink(item.url)?.slug
  const aliases = [...new Set([item.id, `issue:${item.number}`, item.url])]
  const scalarIndex = createTaskPageGitHubScalarAuthorityIndex()
  const captured = sources.map((source, index) => {
    const scope = githubTaskSourceKey(source)
    return {
      scope,
      observation: observations[index],
      scalars: aliases.map((alias) =>
        scalarIndex({ ...item, id: alias }, scope, observations[index], 'state')
      ),
      list: getConfirmedListSnapshot(scope, item.repoId, id, 'assignees', observations[index])
    }
  })
  const logins = (users: readonly GitHubAssignableUser[] = []) =>
    users
      .map((u) => u.login.toLowerCase())
      .sort()
      .join('\0')
  return (accepted: Pick<GitHubWorkItem, 'state' | 'assignees'>): boolean =>
    batchTaskPageGitHubMutationRegistry(() => {
      const currentIndex = createTaskPageGitHubScalarAuthorityIndex()
      const entries = captured.map((capture) => ({
        ...capture,
        currentScalars: aliases.map((alias) =>
          currentIndex({ ...item, id: alias }, capture.scope, capture.observation, 'state')
        ),
        currentList: getConfirmedListSnapshot(
          capture.scope,
          item.repoId,
          id,
          'assignees',
          capture.observation
        )
      }))
      const sameQuery = query === getTaskPageGitHubMutationQueryKey()
      for (const entry of entries) {
        if (
          entry.currentScalars.some(
            (scalar, i) =>
              scalar &&
              scalar.value !== accepted.state &&
              (!sameQuery || scalar !== entry.scalars[i])
          )
        ) {
          return false
        }
        if (
          entry.currentList &&
          logins(entry.currentList) !== logins(accepted.assignees) &&
          (!sameQuery || entry.currentList !== entry.list)
        ) {
          return false
        }
      }
      for (const entry of entries) {
        for (const scalar of entry.currentScalars) {
          if (scalar && scalar.value !== accepted.state) {
            deleteLastConfirmedClientValue(
              scalar.sourceScope,
              item.repoId,
              scalar.itemId,
              'state',
              owner
            )
          }
        }
        if (entry.currentList && logins(entry.currentList) !== logins(accepted.assignees)) {
          deleteConfirmedListSnapshot(entry.scope, item.repoId, id, 'assignees', entry.observation)
        }
      }
      notifyTaskPageGitHubMutationRegistry()
      return true
    })
}
