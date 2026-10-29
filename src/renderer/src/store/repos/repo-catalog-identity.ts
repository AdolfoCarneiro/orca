import type { ProjectGroupingSettings } from '../../../../shared/project-grouping'
import type { Repo } from '../../../../shared/repo-types'
import { applyInheritedProjectGroups } from '../../../../shared/project-group-inheritance'
import { reconcileFetchedRepos } from '../slices/repo-identity-reconcile'
import { getRepoHostIdentity } from '../slices/repo-host-identity'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import type { RepoSlice } from './repo-state'
import { mergeFetchedProjectCompatibilityForHost } from '../../../../shared/project-compatibility-host-merge'
import { projectCompatibilityFromRepos } from '../../../../shared/project-compatibility-merge'
import { mergeByIdentity } from '../catalog-identity'

export function mergeFetchedReposForHost(
  previous: readonly Repo[],
  fetched: readonly Repo[],
  hostId: string,
  settings?: ProjectGroupingSettings | null
): readonly Repo[] {
  const fetchedWithProjectGroups = applyInheritedProjectGroups(previous, fetched, settings)
  const fetchedIdentities = new Set(fetchedWithProjectGroups.map(getRepoHostIdentity))
  const preserved = previous.filter((repo) => {
    const existingHostId = getRepoExecutionHostId(repo)
    return existingHostId !== hostId || fetchedIdentities.has(getRepoHostIdentity(repo))
  })
  return reconcileFetchedRepos(
    previous,
    mergeByIdentity(preserved, fetchedWithProjectGroups, getRepoHostIdentity)
  )
}

export function mergeProjectCompatibilityForHostRepoChange({
  previous,
  nextRepos,
  hostId
}: {
  previous: Pick<RepoSlice, 'projects' | 'projectHostSetups'>
  nextRepos: readonly Repo[]
  hostId: string
}): Pick<RepoSlice, 'projects' | 'projectHostSetups'> {
  return mergeFetchedProjectCompatibilityForHost({
    previous,
    fetched: projectCompatibilityFromRepos(nextRepos),
    repos: nextRepos,
    hostId
  })
}
