import type { Repo } from '../repo-types'
import type { WorkspaceStatusDefinition, Worktree } from '../worktree/types'
import type { ProjectSectionModel } from '../project-section-grouping'
import type { WorktreeOccurrenceSection } from '../worktree-occurrence-plan'
import type { WorktreeGroupEntry, OrderedGroupEntry } from './worktree-group-entry'
import { PINNED_GROUP_KEY } from './group-keys'
import { ALL_GROUP_KEY } from './group-keys'
import type { SidebarPRGroupReader, WorktreeGroupBy } from './row-types'
import { getGroupKeyForWorktree } from './worktree-group-keys'

export function getRenderedNaturalAnchorRepoIds({
  groupBy,
  worktrees,
  repoMap,
  prGroupOf,
  collapsedGroups,
  workspaceStatuses,
  workspaceStatusById,
  projectGrouping
}: {
  groupBy: WorktreeGroupBy
  worktrees: readonly Worktree[]
  repoMap: Map<string, Repo>
  prGroupOf: SidebarPRGroupReader
  collapsedGroups: ReadonlySet<string>
  workspaceStatusById?: ReadonlyMap<string, WorkspaceStatusDefinition>
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
  projectGrouping?: ProjectSectionModel
}): Set<string> {
  const renderedRepoIds = new Set<string>()
  if (groupBy === 'none') {
    if (!collapsedGroups.has(ALL_GROUP_KEY)) {
      for (const worktree of worktrees) {
        renderedRepoIds.add(worktree.repoId)
      }
    }
    return renderedRepoIds
  }
  if (groupBy === 'repo') {
    for (const worktree of worktrees) {
      renderedRepoIds.add(worktree.repoId)
    }
    return renderedRepoIds
  }
  for (const worktree of worktrees) {
    const groupKey = getGroupKeyForWorktree(
      groupBy,
      worktree,
      repoMap,
      prGroupOf,
      workspaceStatuses,
      projectGrouping,
      workspaceStatusById
    )
    if (groupKey && !collapsedGroups.has(groupKey)) {
      renderedRepoIds.add(worktree.repoId)
    }
  }
  return renderedRepoIds
}

export function orderMainWorktreeFirst<T extends { isMainWorktree?: boolean }>(
  worktrees: T[]
): T[] {
  const mainWorktrees = worktrees.filter((worktree) => worktree.isMainWorktree)
  if (mainWorktrees.length === 0) {
    return worktrees
  }
  // Keep canonical workspaces first for repo-scanned project groups despite dynamic child ranking.
  return [...mainWorktrees, ...worktrees.filter((worktree) => !worktree.isMainWorktree)]
}

export function getOrderedOccurrenceGroups(
  sections: readonly (WorktreeOccurrenceSection<Worktree> & { group: WorktreeGroupEntry })[]
) {
  const pinnedSectionWorktrees =
    sections.find((section) => section.key === PINNED_GROUP_KEY)?.group.items ?? []
  const orderedGroups: OrderedGroupEntry[] = sections
    .filter((section) => section.key !== PINNED_GROUP_KEY)
    .map((section) => [section.key, section.group])
  const naturalWorktrees = orderedGroups.flatMap(([, group]) => group.items)
  return { pinnedSectionWorktrees, orderedGroups, naturalWorktrees }
}
