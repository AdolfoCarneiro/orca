import {
  carryProjectStateThroughIdentityChange,
  carryProjectGroupingOverrides
} from '../../../../shared/project-identity-succession'
import type { Repo } from '../../../../shared/repo-types'
import type { Project } from '../../../../shared/project-types'
import { getProjectIdentityKey } from '../../../../shared/project-host-setup-projection'
import type { AppState } from '../types'

/** Only explicit removals retire overrides; a temporarily absent host catalog cannot. */
export function retireRemovedProjectGroupingState(get: () => AppState, repo: Repo): void {
  const state = get()
  const projectId = getProjectIdentityKey(repo)
  if (state.repos.some((repo) => getProjectIdentityKey(repo) === projectId)) {
    return
  }
  for (const key of state.collapsedGroups) {
    if (key === `project:${projectId}` || key.startsWith(`project:${projectId}::host:`)) {
      state.toggleCollapsedGroup(key)
    }
  }
  void state
    .updateSettingsOrThrow((current) => {
      const overrides = { ...current.projectGroupingOverrides }
      delete overrides[projectId]
      return { projectGroupingOverrides: overrides }
    })
    .catch((error) => {
      console.error('Failed to save removed project grouping preference:', error)
    })
}

export function carryFetchedProjectGroupingOverrides(
  get: () => AppState,
  previous: readonly Project[]
): void {
  const state = get()
  const { remappedProjectIds } = carryProjectStateThroughIdentityChange(state.projects, previous)
  if (!remappedProjectIds.size) {
    return
  }
  void state
    .updateSettingsOrThrow((current) => ({
      projectGroupingOverrides: carryProjectGroupingOverrides(
        current.projectGroupingOverrides ?? {},
        remappedProjectIds
      )
    }))
    .catch((error) => {
      console.error('Failed to save project grouping preference after identity change:', error)
    })
}

export function filterRemovedProjectRepoIds(
  ids: readonly string[],
  repoId: string,
  hostId: string
): string[] {
  const removed = `${hostId}\0${repoId}`
  const hasOtherHost = ids.some((id) => id !== removed && id.endsWith(`\0${repoId}`))
  return ids.filter((id) => id !== removed && (id !== repoId || hasOtherHost))
}
