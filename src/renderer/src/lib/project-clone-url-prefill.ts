import type { ProjectGroupingSettings } from '../../../shared/project-grouping'
import {
  buildRepoProjectGroupingIndex,
  getProjectGroupForRepo,
  type ProjectGroupingIndex
} from '../../../shared/project-section-grouping'
import { stripCredentialsFromMessage } from '../../../shared/git-remote-error'
import type { Project } from '../../../shared/project-types'
import type { Repo } from '../../../shared/repo-types'
import { getProjectGroupingIndexFromState } from '@/store/project-host-setup-selector'
import type { AppState } from '@/store/types'

const prefills = new WeakMap<ProjectGroupingIndex, Map<string | null, string>>()

export function selectProjectCloneUrlPrefill(state: AppState, projectId: string | null): string {
  if (!projectId) {
    return ''
  }
  const grouping = getProjectGroupingIndexFromState(state)
  let cached = prefills.get(grouping)
  if (!cached) {
    cached = new Map()
    prefills.set(grouping, cached)
  }
  const existing = cached.get(projectId)
  if (existing !== undefined) {
    return existing
  }
  const value = resolveProjectCloneUrlPrefill(
    state.projects,
    state.repos,
    projectId,
    undefined,
    grouping
  )
  cached.set(projectId, value)
  return value
}

/** Seed from the project remote after stripping embedded credentials: target-host clone persists URLs to .git/config and must not receive an unentered PAT. Match getProvisionedRootRecipeRepoUrl. */
export function resolveProjectCloneUrlPrefill(
  projects: readonly Project[],
  repos: readonly Repo[],
  selectedProjectId: string | null,
  settings?: ProjectGroupingSettings | null,
  grouping?: ProjectGroupingIndex
): string {
  if (!selectedProjectId) {
    return ''
  }
  const projectIndex = selectedProjectId.startsWith('project:')
    ? (grouping ?? buildRepoProjectGroupingIndex(repos, settings))
    : null
  const sourceRepoIds = selectedProjectId.startsWith('project:')
    ? repos
        .filter(
          (repo) =>
            (projectIndex
              ? getProjectGroupForRepo(projectIndex, repo)?.key
              : `project:repo:${repo.id}`) === selectedProjectId
        )
        .map((repo) => repo.id)
    : (projects.find((candidate) => candidate.id === selectedProjectId)?.sourceRepoIds ?? [])
  let reposById: Map<string, Repo> | undefined
  for (let index = 0; index < sourceRepoIds.length; index++) {
    if (index > 0 && !reposById) {
      reposById = new Map()
      for (const repo of repos) {
        const id = repo.id
        if (!reposById.has(id)) {
          reposById.set(id, repo)
        }
      }
    }
    const sourceId = sourceRepoIds[index]
    const source = reposById ? reposById.get(sourceId) : repos.find((repo) => repo.id === sourceId)
    const remoteUrl = source?.gitRemoteIdentity?.remoteUrl
    if (remoteUrl) {
      return stripCredentialsFromMessage(remoteUrl)
    }
  }
  return ''
}
