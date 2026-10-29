import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { getProjectGroupingIndexFromState } from '@/store/project-host-setup-selector'
import { getRepoHostIdentity } from '@/store/slices/repo-host-identity'
import {
  selectedProjectFilterKeys,
  projectFilterMemberIds
} from '../../../../shared/project-repo-filter-selection'

export function useProjectFilterOptions(filterRepoIds: readonly string[]) {
  const repos = useAppStore((s) => s.repos)
  const index = useAppStore(getProjectGroupingIndexFromState)
  const groupedRepos = useMemo(() => {
    const byIdentity = new Map(repos.map((repo) => [getRepoHostIdentity(repo), repo]))
    return index.groups.flatMap((group) => {
      const repo = byIdentity.get(`${group.representative.hostId}\0${group.representative.repoId}`)
      return repo ? [{ ...repo, id: group.key, displayName: group.label }] : []
    })
  }, [repos, index])
  const selectedKeys = useMemo(
    () => selectedProjectFilterKeys(index, filterRepoIds),
    [index, filterRepoIds]
  )
  const memberIds = (keys: readonly string[]) => projectFilterMemberIds(index, keys, filterRepoIds)
  return { repos: groupedRepos, selectedKeys, memberIds }
}
