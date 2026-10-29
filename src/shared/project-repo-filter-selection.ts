import type { ProjectGroupingIndex } from './project-section-grouping'
import { projectRepoFilterMatcher } from './project-grouping'

export type ProjectFilterSelection = {
  active: boolean
  fullKeys: string[]
  partialKeys: string[]
  matchingKeys: string[]
  full: ReadonlySet<string>
  partial: ReadonlySet<string>
  matching: ReadonlySet<string>
  unresolved: string[]
  badgeCount: number
}

const selections = new WeakMap<
  ProjectGroupingIndex,
  WeakMap<readonly string[], ProjectFilterSelection>
>()

export function projectFilterSelection(
  index: ProjectGroupingIndex,
  ids: readonly string[]
): ProjectFilterSelection {
  let cache = selections.get(index)
  if (!cache) {
    cache = new WeakMap()
    selections.set(index, cache)
  }
  const cached = cache.get(ids)
  if (cached) {
    return cached
  }
  const matches = projectRepoFilterMatcher(ids)
  const fullKeys: string[] = []
  const partialKeys: string[] = []
  const matchingKeys: string[] = []
  if (ids.length) {
    for (const group of index.groups) {
      let count = 0
      for (const setup of group.registrations) {
        if (matches(setup.repoId, setup.hostId)) {
          count++
        }
      }
      if (!count) {
        continue
      }
      matchingKeys.push(group.key)
      ;(count === group.registrations.length ? fullKeys : partialKeys).push(group.key)
    }
  }
  const unresolved = ids.filter((id) =>
    id.includes('\0') ? !index.setupByRepoHost.has(id) : !index.setupByRepoId.has(id)
  )
  const result = {
    active: ids.length > 0,
    fullKeys,
    partialKeys,
    matchingKeys,
    full: new Set(fullKeys),
    partial: new Set(partialKeys),
    matching: new Set(matchingKeys),
    unresolved,
    badgeCount: ids.length ? Math.max(1, matchingKeys.length) : 0
  }
  cache.set(ids, result)
  return result
}

export function editProjectFilter(
  index: ProjectGroupingIndex,
  previous: readonly string[],
  intent: { kind: 'clear' } | { kind: 'complete' | 'remove'; keys: readonly string[] }
): string[] {
  if (intent.kind === 'clear') {
    return []
  }
  const touched = new Set<string>()
  const touchedRepoIds = new Set<string>()
  for (const key of intent.keys) {
    for (const setup of index.groupByKey.get(key)?.registrations ?? []) {
      touched.add(`${setup.hostId}\0${setup.repoId}`)
      touchedRepoIds.add(setup.repoId)
    }
  }
  const matches = projectRepoFilterMatcher(previous)
  const result = previous.filter((id) =>
    id.includes('\0') ? !touched.has(id) : !touchedRepoIds.has(id)
  )
  const retainedByRepo = new Map<string, string[]>()
  const totalByRepo = new Map<string, number>()
  for (const [identity, setup] of index.setupByRepoHost) {
    if (!touchedRepoIds.has(setup.repoId)) {
      continue
    }
    totalByRepo.set(setup.repoId, (totalByRepo.get(setup.repoId) ?? 0) + 1)
    if (
      touched.has(identity)
        ? intent.kind === 'complete'
        : previous.length > 0 && matches(setup.repoId, setup.hostId)
    ) {
      const selected = retainedByRepo.get(setup.repoId) ?? []
      selected.push(identity)
      retainedByRepo.set(setup.repoId, selected)
    }
  }
  for (const [repoId, identities] of retainedByRepo) {
    result.push(...(identities.length === totalByRepo.get(repoId) ? [repoId] : identities))
  }
  return [...new Set(result)]
}
