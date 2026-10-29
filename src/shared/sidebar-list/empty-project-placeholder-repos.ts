import { getRepoExecutionHostId } from '../execution-host'
import { projectRepoFilterMatcher } from '../project-grouping'
import type { Repo } from '../repo-types'
import type { Worktree } from '../worktree/types'
import type { WorktreeGroupBy } from './row-types'

export function getEmptyProjectPlaceholderRepoIds(args: {
  groupBy: WorktreeGroupBy
  repos: readonly Repo[]
  worktreesByRepo: Readonly<Record<string, readonly Worktree[] | undefined>>
  visibleWorktrees: readonly Worktree[]
  filterRepoIds: readonly string[]
}): Set<string> {
  if (args.groupBy !== 'repo') {
    return new Set()
  }

  const matchesRepo = projectRepoFilterMatcher(args.filterRepoIds)
  const visibleRepoIds = new Set(args.visibleWorktrees.map((worktree) => worktree.repoId))
  const placeholderRepoIds = new Set<string>()
  for (const repo of args.repos) {
    if (!matchesRepo(repo.id, getRepoExecutionHostId(repo))) {
      continue
    }
    const hasNoWorktrees = (args.worktreesByRepo[repo.id]?.length ?? 0) === 0
    // Workspace filters must not change persisted Project Group membership (#8865).
    const isFilteredProjectGroupMember = repo.projectGroupId != null && !visibleRepoIds.has(repo.id)
    if (hasNoWorktrees || isFilteredProjectGroupMember) {
      placeholderRepoIds.add(repo.id)
    }
  }
  return placeholderRepoIds
}
