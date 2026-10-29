import type { GitHubOwnerRepo } from './pull-request-types'
import type { GitHubWorkItem, GitHubWorkItemDetails } from './work-item-types'
import { githubRepoIdentityKey } from './repository-identity-key'

export type GitHubWorkItemTarget = {
  repository: GitHubOwnerRepo
  type: 'issue' | 'pr'
  number: number
}

export function matchesGitHubWorkItemTarget(
  item: Pick<GitHubWorkItem, 'url' | 'prRepo' | 'type' | 'number'> | null | undefined,
  target: GitHubWorkItemTarget
): boolean {
  if (!item || item.type !== target.type || item.number !== target.number) {
    return false
  }
  try {
    const url = new URL(item.url)
    const parts = url.pathname.split('/').filter(Boolean)
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      parts.length !== 4 ||
      parts[2] !== (target.type === 'pr' ? 'pull' : 'issues') ||
      parts[3] !== String(target.number)
    ) {
      return false
    }
    const repository = { host: url.host, owner: parts[0], repo: parts[1] }
    const key = githubRepoIdentityKey(repository)
    return (
      key === githubRepoIdentityKey(target.repository) &&
      (!item.prRepo || githubRepoIdentityKey(item.prRepo) === key)
    )
  } catch {
    return false
  }
}

export class GitHubWorkItemTargetError extends Error {
  constructor(target: GitHubWorkItemTarget) {
    const { owner, repo } = target.repository
    super(
      `Couldn't load ${owner}/${repo}#${target.number} from this server. Try again or open the ${target.type === 'pr' ? 'pull request' : 'issue'} on GitHub.`
    )
  }
}

export function requireGitHubWorkItemTargetDetails(
  details: GitHubWorkItemDetails | null,
  target: GitHubWorkItemTarget
): GitHubWorkItemDetails {
  if (!details || !matchesGitHubWorkItemTarget(details.item, target)) {
    throw new GitHubWorkItemTargetError(target)
  }
  return details
}
