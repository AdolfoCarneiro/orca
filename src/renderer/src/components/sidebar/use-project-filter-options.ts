import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { getProjectGroupingIndexFromState } from '@/store/project-host-setup-selector'
import { getRepoHostIdentity } from '@/store/slices/repo-host-identity'
import {
  projectFilterSelection,
  editProjectFilter
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
  const selection = useMemo(
    () => projectFilterSelection(index, filterRepoIds),
    [index, filterRepoIds]
  )
  return {
    repos: groupedRepos,
    selection,
    edit: (kind: 'complete' | 'remove', keys: readonly string[]) =>
      editProjectFilter(index, filterRepoIds, { kind, keys })
  }
}
