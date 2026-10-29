import type { Project, ProjectHostSetup } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import { buildProjectGroups, getProjectGroupKey } from '../../../../shared/project-grouping'
import type { ProjectGroupingModel } from '../../../../shared/project-section-grouping'

export type SettingsProject = {
  projectId: string
  project: Project
  setups: ProjectHostSetup[]
  representativeRepoId: string
  /** Resolved group key used by this entry's host selection. */
  selectionKey: string
  /** Label for a host or folder group. */
  checkoutLabel?: string
  /** This entry holds a host or folder subset of its repository. */
  splitProject?: boolean
}

function getCheckoutSelectionKey(projectId: string, repoId: string): string {
  return `${projectId}::setup:${repoId}`
}

/** Carry the latest explicit host pick across split/unsplit selection keys while that host remains present. */
export function getSettingsEntryHostSelection(
  settingsProject: SettingsProject,
  hostSelection: Readonly<Record<string, ExecutionHostId>>,
  setupSelection: Readonly<Record<string, string>>
): { hostId: ExecutionHostId | undefined; setupId: string | undefined } {
  const { projectId, selectionKey, setups } = settingsProject
  const keys = new Set([
    selectionKey,
    projectId,
    ...setups.map((setup) => getCheckoutSelectionKey(projectId, setup.repoId)),
    ...setups.flatMap((setup) =>
      (['repository', 'host', 'folder'] as const).map((mode) => getProjectGroupKey(setup, mode))
    )
  ])
  // Selection records are ordered by the store's last explicit pick, including alias keys.
  for (const key of Object.keys(hostSelection).toReversed()) {
    if (!keys.has(key)) {
      continue
    }
    const hostId = hostSelection[key]
    const setupId = setupSelection[key]
    if (setups.some((setup) => setup.hostId === hostId && (!setupId || setup.id === setupId))) {
      return { hostId, setupId }
    }
  }
  return { hostId: undefined, setupId: undefined }
}

export type SettingsProjectRemovalScope = 'project' | 'checkout' | `host:${string}`

export function getSettingsProjectRemovalScope(
  settingsProject: SettingsProject
): SettingsProjectRemovalScope {
  if (
    settingsProject.selectionKey.includes('::host:') &&
    !settingsProject.selectionKey.includes('::setup:')
  ) {
    return `host:${settingsProject.setups[0]?.hostId ?? ''}`
  }
  if (settingsProject.selectionKey.includes('::setup:')) {
    return 'checkout'
  }
  return 'project'
}

/** Prefer local, then lowest repo ID, to keep navigation and pane identity stable until that repo is removed. */
export function getSettingsProjectRepresentativeRepoId(
  setups: readonly ProjectHostSetup[]
): string {
  const localSetup = setups.find(
    (setup) => setup.hostId === LOCAL_EXECUTION_HOST_ID && setup.repoId.trim().length > 0
  )
  if (localSetup) {
    return localSetup.repoId
  }
  let lowest = ''
  for (const setup of setups) {
    const repoId = setup.repoId.trim()
    if (repoId.length > 0 && (lowest === '' || repoId < lowest)) {
      lowest = repoId
    }
  }
  return lowest
}

/** Settings and the sidebar use the same project membership. */
export function buildSettingsProjectList(
  repos: readonly Repo[],
  projectGrouping?: ProjectGroupingModel
): SettingsProject[] {
  const projection = projectHostSetupProjectionFromRepos(repos)
  const projectById = new Map(projection.projects.map((project) => [project.id, project]))
  const model = projectGrouping ?? {
    projects: projection.projects,
    projectHostSetups: projection.setups
  }
  return buildProjectGroups(model).flatMap((group) => {
    const projectId = group.representative.projectId
    const project =
      projectGrouping?.projects.find((candidate) => candidate.id === projectId) ??
      projectById.get(projectId)
    if (!project) {
      return []
    }
    return [
      {
        projectId,
        selectionKey: group.key,
        project,
        setups: group.members,
        representativeRepoId: group.representative.repoId,
        ...(group.key.includes('::host:') ? { checkoutLabel: group.label, splitProject: true } : {})
      }
    ]
  })
}

/** Validate saved host selection against live setups; fall back to local, ready, then first. */
export function resolveEffectiveProjectHost(
  setups: readonly ProjectHostSetup[],
  selectedHostId: ExecutionHostId | undefined
): ExecutionHostId | undefined {
  if (setups.length === 0) {
    return undefined
  }
  if (selectedHostId && setups.some((setup) => setup.hostId === selectedHostId)) {
    return selectedHostId
  }
  const localSetup = setups.find((setup) => setup.hostId === LOCAL_EXECUTION_HOST_ID)
  if (localSetup) {
    return localSetup.hostId
  }
  const readySetup = setups.find((setup) => setup.setupState === 'ready')
  return (readySetup ?? setups[0]).hostId
}

/** Map host repo IDs to collapsed panes for repository deep links. */
export function buildRepoIdToRepresentative(
  projects: readonly SettingsProject[]
): Map<string, string> {
  const map = new Map<string, string>()
  for (const settingsProject of projects) {
    for (const setup of settingsProject.setups) {
      if (setup.repoId.trim().length > 0) {
        map.set(setup.repoId, settingsProject.representativeRepoId)
      }
    }
  }
  return map
}

/** Which entry, host and setup row a Settings deep link opens. */
export type SettingsProjectHostSelection = {
  selectionKey: string
  hostId: ExecutionHostId
  setupId: string
}

/** Resolve deep links to their exact setup: one host can own several (e.g. Windows + WSL clones). */
export function buildRepoIdToHostSelection(
  projects: readonly SettingsProject[]
): Map<string, SettingsProjectHostSelection> {
  const map = new Map<string, SettingsProjectHostSelection>()
  for (const settingsProject of projects) {
    for (const setup of settingsProject.setups) {
      if (setup.repoId.trim().length > 0 && !map.has(setup.repoId)) {
        map.set(setup.repoId, {
          selectionKey: settingsProject.selectionKey,
          hostId: setup.hostId,
          setupId: setup.id
        })
      }
    }
  }
  return map
}

export function getSettingsTargetHostSelection(
  projects: readonly SettingsProject[],
  repoId: string,
  hostId: ExecutionHostId
): SettingsProjectHostSelection | null {
  for (const settingsProject of projects) {
    const setup = settingsProject.setups.find(
      (candidate) => candidate.repoId === repoId && candidate.hostId === hostId
    )
    if (setup) {
      return { selectionKey: settingsProject.selectionKey, hostId, setupId: setup.id }
    }
  }
  return null
}

/** Repo IDs may contain hyphens; match known IDs longest-first in subsection links. */
export function resolveSettingsTargetRepoId(
  target: { repoId: string | null; sectionId?: string },
  repoIds: Iterable<string>
): string | null {
  if (target.repoId) {
    return target.repoId
  }
  const sectionId = target.sectionId
  if (!sectionId || !sectionId.startsWith('repo-')) {
    return null
  }
  let best: string | null = null
  for (const repoId of repoIds) {
    if (sectionId === `repo-${repoId}` || sectionId.startsWith(`repo-${repoId}-`)) {
      if (best === null || repoId.length > best.length) {
        best = repoId
      }
    }
  }
  return best
}

/** Remove sequentially to avoid interleaved teardown/projection updates; planned hosts have no repo to remove. */
export async function removeSettingsProjectFromAllHosts(
  setups: readonly ProjectHostSetup[],
  removeProject: (
    repoId: string,
    options: { hostId: ExecutionHostId; errorFeedback?: 'toast' | 'silent' }
  ) => Promise<void>
): Promise<void> {
  for (const setup of setups) {
    if (setup.repoId.trim().length > 0) {
      // Surface failures from user-initiated removal.
      await removeProject(setup.repoId, { hostId: setup.hostId, errorFeedback: 'toast' })
    }
  }
}

/** Keep pane rendering and hook loading on the same repo ID and host, including same-ID self-pairs. */
export function getSettingsProjectHostRepo(
  settingsProject: SettingsProject,
  repos: readonly Repo[],
  selectedHostId: ExecutionHostId | undefined,
  selectedSetupId?: string
): Repo | undefined {
  const effectiveHostId = resolveEffectiveProjectHost(settingsProject.setups, selectedHostId)
  if (!effectiveHostId) {
    return undefined
  }
  const effectiveSetup =
    settingsProject.setups.find(
      (setup) => setup.id === selectedSetupId && setup.hostId === effectiveHostId
    ) ??
    settingsProject.setups.find((setup) => setup.hostId === effectiveHostId) ??
    settingsProject.setups[0]
  return (
    repos.find(
      (repo) =>
        repo.id === effectiveSetup.repoId && getRepoExecutionHostId(repo) === effectiveHostId
    ) ??
    repos.find((repo) => repo.id === effectiveSetup.repoId) ??
    repos.find((repo) => repo.id === settingsProject.representativeRepoId)
  )
}
