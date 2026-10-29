import { getTaskSourceCacheScope } from '../../../shared/task-source-context'
import { getGitHubRuntimeRepoId } from '@/lib/github-source-runtime-context'
import { supportsGitHubWorkItemTarget } from '@/lib/github-work-item-target-request'
import { useGitHubWorkItemTarget } from '@/components/github-item-dialog/load-item-details/github-work-item-target-context'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type {
  GitHubAssignableUser,
  GitHubOwnerRepo
} from '../../../shared/github/pull-request-types'
import { githubRepoIdentityKey } from '../../../shared/github/repository-identity-key'
import { createMetadataRequestStore } from './metadata-request-cache'
import { useMetadataListRequest, type MetadataListState } from './useMetadataListRequest'

type GitHubMetadataOptions = {
  /** The repo owner's transport; absent reads through this app. */
  target?: RuntimeClientTarget | null
  ownerRepo?: GitHubOwnerRepo | null
}

const ghLabelStore = createMetadataRequestStore<string[]>()
const ghAssigneeStore = createMetadataRequestStore<GitHubAssignableUser[]>()

export function useRepoLabels(
  repoPath: string | null,
  repoId?: string | null,
  options?: GitHubMetadataOptions
): MetadataListState<string> {
  const bound = useGitHubWorkItemTarget()
  const target = bound?.target ?? options?.target ?? { kind: 'local' as const }
  const runtimeEnvironmentId = target.kind === 'environment' ? target.environmentId : null
  const repoSelector = runtimeEnvironmentId
    ? (getGitHubRuntimeRepoId(bound?.sourceContext, repoId) ?? repoPath ?? '')
    : (repoId ?? repoPath ?? '')
  const ownerRepo = options?.ownerRepo ?? bound?.resource.repository
  const repositoryKey = ownerRepo
    ? `${repoSelector}::${githubRepoIdentityKey(ownerRepo)}::${bound?.sourceContext ? getTaskSourceCacheScope(bound.sourceContext) : ''}::${bound ? `${bound.resource.type}/${bound.resource.number}` : ''}`
    : repoSelector
  const cacheKey =
    repoPath || repoId
      ? runtimeEnvironmentId
        ? `runtime:${runtimeEnvironmentId}:${repositoryKey}`
        : repositoryKey
      : null

  const result = useMetadataListRequest({
    cacheKey,
    store: ghLabelStore,
    errorFallback: 'Failed to load labels',
    load: async () => {
      if (!bound && ownerRepo && !(await supportsGitHubWorkItemTarget(target))) {
        throw new Error(
          'Unable to load repository metadata from this server. Try again or open the item on GitHub.'
        )
      }
      const exactArgs = bound
        ? await bound.prepare().catch((error: unknown) => {
            bound.reportError(error instanceof Error ? error.message : '')
            throw error
          })
        : ownerRepo
          ? { ownerRepo }
          : {}
      return runtimeEnvironmentId
        ? callRuntimeRpc<string[]>(
            { kind: 'environment', environmentId: runtimeEnvironmentId },
            'github.listLabels',
            { repo: repoSelector, ...exactArgs },
            { timeoutMs: 15_000 }
          )
        : window.api.gh.listLabels({
            repoPath: repoPath ?? '',
            repoId: repoId ?? undefined,
            ...(bound?.sourceContext ? { sourceContext: bound.sourceContext } : {}),
            ...exactArgs
          })
    }
  })
  return {
    ...result,
    data: result.resolvedKey === cacheKey ? result.data : [],
    loading:
      result.loading || (cacheKey !== null && result.resolvedKey !== cacheKey && !result.error)
  }
}

export function useRepoAssignees(
  repoPath: string | null,
  repoId?: string | null,
  options?: GitHubMetadataOptions
): MetadataListState<GitHubAssignableUser> {
  const bound = useGitHubWorkItemTarget()
  const target = bound?.target ?? options?.target ?? { kind: 'local' as const }
  const runtimeEnvironmentId = target.kind === 'environment' ? target.environmentId : null
  const repoSelector = runtimeEnvironmentId
    ? (getGitHubRuntimeRepoId(bound?.sourceContext, repoId) ?? repoPath ?? '')
    : (repoId ?? repoPath ?? '')
  const ownerRepo = options?.ownerRepo ?? bound?.resource.repository
  const repositoryKey = ownerRepo
    ? `${repoSelector}::${githubRepoIdentityKey(ownerRepo)}::${bound?.sourceContext ? getTaskSourceCacheScope(bound.sourceContext) : ''}::${bound ? `${bound.resource.type}/${bound.resource.number}` : ''}`
    : repoSelector
  const cacheKey =
    repoPath || repoId
      ? runtimeEnvironmentId
        ? `runtime:${runtimeEnvironmentId}:${repositoryKey}`
        : repositoryKey
      : null

  const result = useMetadataListRequest({
    cacheKey,
    store: ghAssigneeStore,
    errorFallback: 'Failed to load assignees',
    load: async () => {
      if (!bound && ownerRepo && !(await supportsGitHubWorkItemTarget(target))) {
        throw new Error(
          'Unable to load repository metadata from this server. Try again or open the item on GitHub.'
        )
      }
      const exactArgs = bound
        ? await bound.prepare().catch((error: unknown) => {
            bound.reportError(error instanceof Error ? error.message : '')
            throw error
          })
        : ownerRepo
          ? { ownerRepo }
          : {}
      return runtimeEnvironmentId
        ? callRuntimeRpc<GitHubAssignableUser[]>(
            { kind: 'environment', environmentId: runtimeEnvironmentId },
            'github.listAssignableUsers',
            { repo: repoSelector, ...exactArgs },
            { timeoutMs: 15_000 }
          )
        : window.api.gh.listAssignableUsers({
            repoPath: repoPath ?? '',
            repoId: repoId ?? undefined,
            ...(bound?.sourceContext ? { sourceContext: bound.sourceContext } : {}),
            ...exactArgs
          })
    }
  })
  return {
    ...result,
    data: result.resolvedKey === cacheKey ? result.data : [],
    loading:
      result.loading || (cacheKey !== null && result.resolvedKey !== cacheKey && !result.error)
  }
}
