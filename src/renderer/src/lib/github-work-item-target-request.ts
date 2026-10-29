import { isWebClientLocation } from './web-client-location'
import { GITHUB_EXACT_WORK_ITEM_TARGET_RUNTIME_CAPABILITY } from '../../../shared/source-control-runtime-capabilities'
import {
  requireGitHubWorkItemTargetDetails,
  type GitHubWorkItemTarget
} from '../../../shared/github/work-item-target'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import { callRuntimeRpc, runtimeEnvironmentSupportsCapability } from '@/runtime/runtime-rpc-client'
import type { GitHubWorkItemDetails } from '../../../shared/github/work-item-types'
import { getGitHubRuntimeRepoId } from './github-source-runtime-context'

export async function supportsGitHubWorkItemTarget(target: RuntimeClientTarget): Promise<boolean> {
  if (target.kind === 'local' && !isWebClientLocation()) {
    return true
  }
  return target.kind === 'environment'
    ? await runtimeEnvironmentSupportsCapability(
        target.environmentId,
        GITHUB_EXACT_WORK_ITEM_TARGET_RUNTIME_CAPABILITY
      ).catch(() => false)
    : (await window.api.runtime.getStatus().catch(() => null))?.capabilities?.includes(
        GITHUB_EXACT_WORK_ITEM_TARGET_RUNTIME_CAPABILITY
      ) === true
}

export async function prepareGitHubWorkItemTargetRequest(args: {
  target: RuntimeClientTarget
  resource: GitHubWorkItemTarget
  repoPath: string | null
  repoId: string
  sourceContext?: TaskSourceContext | null
}) {
  const supported = await supportsGitHubWorkItemTarget(args.target)
  if (supported) {
    const { owner, repo, host } = args.resource.repository
    return { ownerRepo: { owner, repo, ...(host ? { host } : {}) } }
  }
  // A legacy operation is safe only when its ordinary resolution proves the opened identity.
  const params = { number: args.resource.number, type: args.resource.type }
  const details = await (
    args.target.kind === 'environment'
      ? callRuntimeRpc<GitHubWorkItemDetails | null>(
          args.target,
          'github.workItemDetails',
          {
            repo: getGitHubRuntimeRepoId(args.sourceContext, args.repoId),
            ...params
          },
          { timeoutMs: 30_000 }
        )
      : window.api.gh.workItemDetails({
          repoPath: args.repoPath ?? '',
          repoId: args.repoId,
          sourceContext: args.sourceContext,
          ...params
        })
  ).catch(() => null)
  requireGitHubWorkItemTargetDetails(details, args.resource)
  return {}
}
