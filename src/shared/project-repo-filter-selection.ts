import type { ProjectGroupingIndex } from './project-section-grouping'
import { projectRepoFilterMatcher } from './project-grouping'

export function selectedProjectFilterKeys(
  index: ProjectGroupingIndex,
  ids: readonly string[]
): string[] {
  if (!ids.length) {
    return []
  }
  const matches = projectRepoFilterMatcher(ids)
  return index.groups
    .filter((group) => group.registrations.every((setup) => matches(setup.repoId, setup.hostId)))
    .map((group) => group.key)
}

/** Preserve offline and partial selections while editing whole visible groups. */
export function projectFilterMemberIds(
  index: ProjectGroupingIndex,
  keys: readonly string[],
  previous: readonly string[] = []
): string[] {
  const selected = new Set(keys)
  const matches = projectRepoFilterMatcher(previous)
  const identities = new Set<string>()
  for (const group of index.groups) {
    const partial =
      previous.length > 0 &&
      !group.registrations.every((setup) => matches(setup.repoId, setup.hostId))
    for (const setup of group.registrations) {
      if (selected.has(group.key) || (partial && matches(setup.repoId, setup.hostId))) {
        identities.add(`${setup.hostId}\0${setup.repoId}`)
      }
    }
  }
  const allByRepo = new Map<string, string[]>()
  for (const [identity, setup] of index.setupByRepoHost) {
    const all = allByRepo.get(setup.repoId) ?? []
    all.push(identity)
    allByRepo.set(setup.repoId, all)
  }
  const result = previous.filter((id) =>
    id.includes('\0') ? !index.setupByRepoHost.has(id) : !allByRepo.has(id)
  )
  for (const [repoId, all] of allByRepo) {
    if (all.every((identity) => identities.has(identity))) {
      result.push(repoId)
    } else {
      for (const identity of all) {
        if (identities.has(identity)) {
          result.push(identity)
        }
      }
    }
  }
  return [...new Set(result)]
}
