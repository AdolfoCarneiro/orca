import { getRepoHostIdentityForParts } from './repo-host-identity'
import { LOCAL_EXECUTION_HOST_ID, toSshExecutionHostId } from './execution-host'
import { isWindowsAbsolutePathLike, normalizeRuntimePathForComparison } from './cross-platform-path'
import { parseWslUncPath } from './wsl-paths'
import type { Project, ProjectHostSetup } from './project-types'
import type { Repo } from './repo-types'
import { projectHostSetupProjectionFromRepos } from './project-host-setup-projection'

export type ProjectGroupingMode = 'repository' | 'host' | 'folder'
export type ProjectGroupingPreferences = {
  projectGroupingMode: ProjectGroupingMode
  projectGroupingOverrides: Record<string, ProjectGroupingMode>
}
export type ProjectGroupingSettings = Partial<ProjectGroupingPreferences>
export type GroupingSetup = Pick<
  ProjectHostSetup,
  'id' | 'projectId' | 'hostId' | 'repoId' | 'path' | 'displayName' | 'setupMethod'
> &
  Partial<Pick<ProjectHostSetup, 'kind' | 'connectionId' | 'executionHostId'>> & {
    /** Resolved by the publishing desktop; absent on older catalogs. */
    groupKey?: string
  }
export type GroupingModel<S extends GroupingSetup = GroupingSetup> = {
  projects: readonly Pick<Project, 'id' | 'displayName'>[]
  projectHostSetups: readonly S[]
  settings?: ProjectGroupingSettings | null
}
export type CheckoutProjectGroup<S extends GroupingSetup = GroupingSetup> = {
  key: string
  label: string
  representative: S
  members: S[]
}

export function resolveProjectGroupingMode(
  projectId: string,
  settings?: ProjectGroupingSettings | null
): ProjectGroupingMode {
  return (
    settings?.projectGroupingOverrides?.[projectId] ?? settings?.projectGroupingMode ?? 'repository'
  )
}

export function getProjectHostNamespace(setup: GroupingSetup): string {
  const execution = setup.connectionId?.trim()
    ? toSshExecutionHostId(setup.connectionId.trim())
    : setup.executionHostId?.trim() || setup.hostId
  const wsl = parseWslUncPath(setup.path)
  const surface = wsl
    ? `wsl:${wsl.distro.toLowerCase()}`
    : isWindowsAbsolutePathLike(setup.path)
      ? 'windows-host'
      : 'default'
  return `${setup.hostId}::${execution}::${surface}`
}

export function getPhysicalProjectKey(setup: GroupingSetup): string {
  return `${getProjectHostNamespace(setup)}::${setup.repoId || setup.id}`
}

export function getProjectCheckoutPathKey(setup: GroupingSetup): string {
  return `${getProjectHostNamespace(setup)}\0${normalizeRuntimePathForComparison(setup.path.trim()) || getPhysicalProjectKey(setup)}`
}

export function getProjectGroupKey(setup: GroupingSetup, mode: ProjectGroupingMode): string {
  if (setup.groupKey) {
    return setup.groupKey
  }
  const repository = `project:${setup.projectId}`
  if (setup.projectId.startsWith('repo:')) {
    return `repo:${setup.repoId}`
  }
  if (mode === 'repository') {
    return repository
  }
  const host = `${repository}::host:${getProjectHostNamespace(setup)}`
  return mode === 'folder' && setup.setupMethod !== 'provisioned' && setup.kind !== 'folder'
    ? `${host}::setup:${setup.repoId}`
    : host
}

const groupCache = new WeakMap<object, { signature: string; groups: CheckoutProjectGroup[] }>()

export function selectProjectGroupTarget<S extends GroupingSetup>(
  group: CheckoutProjectGroup<S>,
  hint: {
    setupId?: string | null
    path?: string | null
    contextualRepoId?: string | null
    hostId?: string | null
  } = {}
): S {
  const explicit = (setup: S) =>
    Boolean(
      (hint.setupId && setup.id === hint.setupId) ||
      (hint.path &&
        normalizeRuntimePathForComparison(setup.path) ===
          normalizeRuntimePathForComparison(hint.path))
    )
  return (
    group.members.find(
      (setup) => explicit(setup) && (!hint.hostId || setup.hostId === hint.hostId)
    ) ??
    group.members.find(explicit) ??
    group.members.find((setup) => setup.repoId === hint.contextualRepoId) ??
    group.members.find((setup) => setup.hostId === (hint.hostId ?? LOCAL_EXECUTION_HOST_ID)) ??
    group.representative
  )
}

export function buildProjectGroups<S extends GroupingSetup>(
  model: GroupingModel<S>,
  settings: ProjectGroupingSettings | null | undefined = model.settings
): CheckoutProjectGroup<S>[] {
  const signature = JSON.stringify(
    model.projects.map((project) => [project.id, resolveProjectGroupingMode(project.id, settings)])
  )
  const cached = groupCache.get(model)
  if (cached?.signature === signature) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this model object always contains the same setup subtype.
    return cached.groups as CheckoutProjectGroup<S>[]
  }
  const projects = new Map(model.projects.map((project) => [project.id, project]))
  const physical = new Map<string, S>()
  const pathKeys = new Map<string, string>()
  for (const setup of model.projectHostSetups) {
    const key = getPhysicalProjectKey(setup)
    const pathKey = getProjectCheckoutPathKey(setup)
    const equivalent = pathKeys.get(pathKey)
    const existing = physical.get(equivalent ?? key)
    if (
      !existing ||
      (existing.projectId.startsWith('repo:') && !setup.projectId.startsWith('repo:'))
    ) {
      physical.set(equivalent ?? key, setup)
    }
    pathKeys.set(pathKey, equivalent ?? key)
  }
  const groups = new Map<string, CheckoutProjectGroup<S>>()
  for (const setup of physical.values()) {
    const mode = resolveProjectGroupingMode(setup.projectId, settings)
    const key = getProjectGroupKey(setup, mode)
    const group = groups.get(key)
    if (group) {
      group.members.push(setup)
      if (
        setup.hostId === LOCAL_EXECUTION_HOST_ID &&
        group.representative.hostId !== LOCAL_EXECUTION_HOST_ID
      ) {
        group.representative = setup
      }
    } else {
      groups.set(key, {
        key,
        label:
          key.includes('::setup:') || setup.projectId.startsWith('repo:')
            ? setup.displayName
            : (projects.get(setup.projectId)?.displayName ?? setup.displayName),
        representative: setup,
        members: [setup]
      })
    }
  }
  const result = [...groups.values()]
  groupCache.set(model, { signature, groups: result })
  return result
}

export function getRepoProjectGroupKey(
  repo: Pick<Repo, 'id' | 'path' | 'displayName'> & Partial<Repo>,
  settings?: ProjectGroupingSettings | null
): string {
  const projection = projectHostSetupProjectionFromRepos([{ badgeColor: '', addedAt: 0, ...repo }])
  const setup = projection.setups[0]
  return setup
    ? getProjectGroupKey(setup, resolveProjectGroupingMode(setup.projectId, settings))
    : `repo:${repo.id}`
}

export function projectRepoFilterMatcher(
  ids: readonly string[]
): (repoId: string, hostId: string) => boolean {
  const qualified = ids.filter((id) => id.includes('\0'))
  const selected = new Set(qualified.length ? qualified : ids)
  return (repoId, hostId) =>
    selected.size === 0 ||
    selected.has(qualified.length ? getRepoHostIdentityForParts(repoId, hostId) : repoId)
}
