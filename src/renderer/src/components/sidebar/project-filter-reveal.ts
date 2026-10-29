import { getRepoHostIdentityForParts } from '../../../../shared/repo-host-identity'
import { projectRepoFilterMatcher } from '../../../../shared/project-grouping'
export type ProjectFilterRevealState = {
  filterRepoIds: readonly string[]
  setFilterRepoIds: (repoIds: readonly string[]) => void
}

export function revealRepoInProjectFilter(
  state: ProjectFilterRevealState,
  repoId: string,
  hostId = 'local'
): void {
  // Why: an empty allow-list disables filtering, so adding one id would narrow the unfiltered view.
  if (
    state.filterRepoIds.length === 0 ||
    projectRepoFilterMatcher(state.filterRepoIds)(repoId, hostId)
  ) {
    return
  }
  state.setFilterRepoIds([
    ...state.filterRepoIds,
    repoId,
    ...(state.filterRepoIds.some((id) => id.includes('\0'))
      ? [getRepoHostIdentityForParts(repoId, hostId)]
      : [])
  ])
}
