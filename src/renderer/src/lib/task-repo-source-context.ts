import type { Repo } from '../../../shared/repo-types'
import type { GitLabProjectRef } from '../../../shared/gitlab-types'
import {
  normalizeTaskSourceContext,
  type TaskSourceContext
} from '../../../shared/task-source-context'
import { projectHostSetupProjectionFromRepos } from '../../../shared/project-host-setup-projection'
import { parseExecutionHostId, getRepoExecutionHostId } from '../../../shared/execution-host'
export function getTaskPageRepoSourceContext(
  repo: Repo | null | undefined,
  provider: 'github' | 'gitlab',
  gitlabProjectRef?: GitLabProjectRef | null
): TaskSourceContext | null {
  if (!repo) {
    return null
  }
  const projection = projectHostSetupProjectionFromRepos([repo])
  const project = projection.projects[0]
  const setup = projection.setups[0]
  const providerIdentity =
    provider === 'github' && project?.providerIdentity?.provider === 'github'
      ? project.providerIdentity
      : provider === 'gitlab' && gitlabProjectRef
        ? buildGitLabProviderIdentity(gitlabProjectRef)
        : null
  return normalizeTaskSourceContext({
    provider,
    projectId: setup?.projectId ?? project?.id ?? repo.id,
    hostId: setup?.hostId ?? getRepoExecutionHostId(repo),
    projectHostSetupId: setup?.id,
    repoId: repo.id,
    providerIdentity
  })
}
export function buildGitLabProviderIdentity(projectRef: GitLabProjectRef) {
  const pathParts = projectRef.path
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)
  const projectName = pathParts.at(-1) ?? null
  const namespace = pathParts.length > 1 ? pathParts.slice(0, -1).join('/') : null
  return {
    provider: 'gitlab' as const,
    projectId: projectRef.path,
    namespace,
    project: projectName,
    webUrl: `https://${projectRef.host}/${projectRef.path}`
  }
}

export function shouldSkipLocalViewerQualifiers(sourceContext?: TaskSourceContext | null): boolean {
  if (!sourceContext) {
    return false
  }
  // The local gh viewer cannot evaluate @me soft-hide for SSH/environment rows.
  const hostKind = parseExecutionHostId(sourceContext.hostId)?.kind
  if (hostKind === 'ssh' || hostKind === 'runtime') {
    return true
  }
  const providerHost =
    sourceContext.providerIdentity?.provider === 'github'
      ? sourceContext.providerIdentity.host?.toLowerCase()
      : undefined
  return Boolean(providerHost && providerHost !== 'github.com')
}
