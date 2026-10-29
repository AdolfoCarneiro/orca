import type { GitHubRepoContext } from './github-repository-identity'
import { readCheckedOutBranchState } from '../git/checked-out-branch-ref'
import { resolveLocalGitConfigPaths } from './local-git-config-paths'
import { readLocalGitConfigSignatures, type LocalGitConfigNode } from './local-git-config-traversal'

export const CONFIG_SIGNATURE_DEADLINE_MS = 2_000

export async function readLocalGitConfigScan(
  context: GitHubRepoContext,
  readNode: (configPath: string, isActive: () => boolean) => Promise<LocalGitConfigNode>
): Promise<string | undefined> {
  const deadlineAt = Date.now() + CONFIG_SIGNATURE_DEADLINE_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CONFIG_SIGNATURE_DEADLINE_MS)
  timer.unref?.()
  const isActive = (): boolean => !controller.signal.aborted && Date.now() < deadlineAt
  try {
    const configPaths = await resolveLocalGitConfigPaths(context.repoPath)
    if (!configPaths || !isActive()) {
      return undefined
    }
    const graph = await readLocalGitConfigSignatures(
      [configPaths.commonConfigPath, configPaths.worktreeConfigPath],
      deadlineAt,
      readNode
    )
    if (!graph || !isActive()) {
      return undefined
    }
    const signatures = graph.signatures.sort()
    if (!graph.hasConditionalIncludes) {
      return signatures.join('\0')
    }
    const branch = await readCheckedOutBranchState(context.repoPath, {
      timeout: Math.max(1, deadlineAt - Date.now()),
      signal: controller.signal,
      canStart: isActive,
      terminationBarrier: true,
      ...(context.admissionTier ? { admissionTier: context.admissionTier } : {})
    })
    return branch.kind === 'unknown' || !isActive()
      ? undefined
      : JSON.stringify(['local-config-branch-v1', signatures, branch])
  } finally {
    clearTimeout(timer)
  }
}
