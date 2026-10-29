import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import { getRepoHostIdentityForParts } from '../../../../shared/repo-host-identity'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { buildProjectGroups, projectRepoFilterMatcher } from '../../../../shared/project-grouping'

export function useProjectFilterOptions(filterRepoIds: readonly string[]) {
  const repos = useAppStore((s) => s.repos)
  const settings = useAppStore((s) => s.settings)
  const groups = useMemo(() => {
    const projection = projectHostSetupProjectionFromRepos(repos)
    return buildProjectGroups(
      { projects: projection.projects, projectHostSetups: projection.setups },
      settings
    )
  }, [repos, settings])
  const groupedRepos = useMemo(
    () =>
      groups.flatMap((group) => {
        const repo = repos.find(
          (candidate) =>
            candidate.id === group.representative.repoId &&
            getRepoExecutionHostId(candidate) === group.representative.hostId
        )
        return repo ? [{ ...repo, id: group.key, displayName: group.label }] : []
      }),
    [groups, repos]
  )
  const selectedKeys = useMemo(() => {
    if (!filterRepoIds.length) {
      return []
    }
    const matches = projectRepoFilterMatcher(filterRepoIds)
    return groups
      .filter((group) => group.members.some((setup) => matches(setup.repoId, setup.hostId)))
      .map((group) => group.key)
  }, [groups, filterRepoIds])
  const memberIds = (keys: readonly string[]) => [
    ...new Set(
      groups
        .filter((group) => keys.includes(group.key))
        .flatMap((group) =>
          group.members.flatMap((setup) => [
            setup.repoId,
            // Raw ids keep older clients usable; qualified ids distinguish same-id registrations.
            getRepoHostIdentityForParts(setup.repoId, setup.hostId)
          ])
        )
    )
  ]
  return { repos: groupedRepos, selectedKeys, memberIds }
}
