import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import type { GitHubAssignableUser } from '../../../../../shared/github/pull-request-types'
import { githubTaskSourceKey } from '@/lib/github-task-target'
import { parseGitHubIssueOrPRLink } from '../../../../../shared/github/links'
import { taskPageGitHubMutationItemId } from './task-page-github-work-item-mutation-keys'
import {
  getLastConfirmedClientValue,
  getLastConfirmedClientEntry,
  deleteLastConfirmedClientValue
} from './task-page-github-confirmed-client-values'
import {
  getTaskPageGitHubMutationQueryKey,
  getConfirmedListSnapshot,
  deleteConfirmedListSnapshot,
  notifyTaskPageGitHubMutationRegistry
} from './task-page-github-work-item-mutation-registry'
/** Only the exact completed masks observed before this read may be retired. */
export function captureTaskPageGitHubRefreshMasks(
  item: GitHubWorkItem,
  sources: readonly TaskSourceContext[]
) {
  const query = getTaskPageGitHubMutationQueryKey()
  const id = taskPageGitHubMutationItemId(item)
  const owner = parseGitHubIssueOrPRLink(item.url)?.slug
  const aliases = [...new Set([item.id, `issue:${item.number}`, item.url])]
  const scalarAt = (scope: string, alias: string) =>
    getLastConfirmedClientValue(scope, item.repoId, alias, 'state', owner) === undefined
      ? undefined
      : getLastConfirmedClientEntry(scope, item.repoId, alias, 'state')
  const captured = sources.map((source) => {
    const scope = githubTaskSourceKey(source)
    return {
      scope,
      scalars: aliases.map((alias) => scalarAt(scope, alias)),
      list: getConfirmedListSnapshot(scope, item.repoId, id, 'assignees')
    }
  })
  const logins = (users: readonly GitHubAssignableUser[] = []) =>
    users
      .map((u) => u.login.toLowerCase())
      .sort()
      .join('\0')
  return (accepted: Pick<GitHubWorkItem, 'state' | 'assignees'>): boolean => {
    const entries = captured.map((capture) => ({
      ...capture,
      currentScalars: aliases.map((alias) => scalarAt(capture.scope, alias)),
      currentList: getConfirmedListSnapshot(capture.scope, item.repoId, id, 'assignees')
    }))
    const sameQuery = query === getTaskPageGitHubMutationQueryKey()
    for (const entry of entries) {
      if (
        entry.currentScalars.some(
          (scalar, i) =>
            scalar && scalar.value !== accepted.state && (!sameQuery || scalar !== entry.scalars[i])
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
      for (const [i, scalar] of entry.currentScalars.entries()) {
        if (scalar && scalar.value !== accepted.state) {
          deleteLastConfirmedClientValue(entry.scope, item.repoId, aliases[i], 'state', owner)
        }
      }
      if (entry.currentList && logins(entry.currentList) !== logins(accepted.assignees)) {
        deleteConfirmedListSnapshot(entry.scope, item.repoId, id, 'assignees')
      }
    }
    notifyTaskPageGitHubMutationRegistry()
    return true
  }
}
