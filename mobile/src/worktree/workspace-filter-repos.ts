import {
  buildProjectGroupingIndex,
  type ProjectSectionModel,
  type ProjectGroupingIndex
} from '../../../src/shared/project-section-grouping'
import {
  selectedProjectFilterKeys,
  projectFilterMemberIds
} from '../../../src/shared/project-repo-filter-selection'
import { getRepoExecutionHostId } from '../../../src/shared/execution-host'
import { resolveRepoBadgeColor } from '../../../src/shared/repo-badge-color'
import { buildSectionRepoMap, type SectionRepo, type Worktree } from './workspace-list-sections'

export type WorkspaceSectionRepo = {
  /** Unique per host: two hosts can each hold a repo of the same name. */
  key: string
  name: string
  id: string
  color: string
  grouping?: ProjectGroupingIndex
}

export function sectionRepoColor(repo: Pick<SectionRepo, 'badgeColor'>): string {
  return resolveRepoBadgeColor(repo.badgeColor)
}

// List catalog repos per host; before catalogs arrive, derive candidates from workspace rows.
export function buildFilterRepos(
  filterCatalogRepos: readonly SectionRepo[],
  worktrees: readonly Worktree[],
  grouping?: ProjectSectionModel | null
): WorkspaceSectionRepo[] {
  const repos =
    filterCatalogRepos.length > 0
      ? filterCatalogRepos
      : [...buildSectionRepoMap([], worktrees).values()]
  if (grouping) {
    const index = buildProjectGroupingIndex(grouping)
    const repoByHost = new Map(
      repos.map((repo) => [`${getRepoExecutionHostId(repo)}\0${repo.id}`, repo])
    )
    return index.groups.flatMap((group) => {
      const setup = group.representative
      const repo = repoByHost.get(`${setup.hostId}\0${setup.repoId}`)
      return repo
        ? [
            {
              key: group.key,
              id: group.key,
              name: group.label,
              color: sectionRepoColor(repo),
              grouping: index
            }
          ]
        : []
    })
  }
  const seen = new Set<string>()
  return repos.flatMap((repo) => {
    const key = `${getRepoExecutionHostId(repo)}|${repo.id}`
    if (seen.has(key)) {
      return []
    }
    seen.add(key)
    return [{ key, id: repo.id, name: repo.displayName, color: sectionRepoColor(repo) }]
  })
}

export function selectedWorkspaceProjectKeys(
  repos: readonly WorkspaceSectionRepo[],
  selected: readonly string[]
): Set<string> {
  const index = repos.find((repo) => repo.grouping)?.grouping
  return new Set(
    index
      ? selectedProjectFilterKeys(index, selected)
      : repos.filter((repo) => selected.includes(repo.id)).map((repo) => repo.key)
  )
}

export function toggleProjectFilter(
  repo: WorkspaceSectionRepo,
  selected: readonly string[]
): string[] {
  if (!repo.grouping) {
    return selected.includes(repo.id)
      ? selected.filter((id) => id !== repo.id)
      : [...selected, repo.id]
  }
  const checked = selectedProjectFilterKeys(repo.grouping, selected)
  const keys = checked.includes(repo.key)
    ? checked.filter((key) => key !== repo.key)
    : [...checked, repo.key]
  return projectFilterMemberIds(repo.grouping, keys, selected)
}
