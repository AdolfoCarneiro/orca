import { invalidateReviewLookupsAfterPRMutation } from '../../pr-mutation-review-invalidation'
import { ghExecFileAsync, acquire, release, type LocalGitExecOptions } from '../../gh-utils'
import { resolveGitHubRepoExecution, type GitHubApiRepository } from '../../github-api-repository'
import { codeHostFailure } from '../../../../shared/code-host-failure-copy'
export async function requestPRReviewers(
  repoPath: string,
  prNumber: number,
  reviewers: string[],
  connectionId?: string | null,
  prRepo?: GitHubApiRepository | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<{ ok: true } | { ok: false; error: string }> {
  const logins = reviewers.map((reviewer) => reviewer.trim()).filter(Boolean)
  if (logins.length === 0) {
    return codeHostFailure('github.reviewerRequired')
  }
  const { ownerRepo, ghOptions } = await resolveGitHubRepoExecution(
    repoPath,
    prRepo,
    connectionId,
    localGitOptions
  )
  if (!ownerRepo) {
    return codeHostFailure('github.repoUnresolved')
  }
  await acquire()
  try {
    const args = ['pr', 'edit', String(prNumber), '--add-reviewer', logins.join(',')]
    if (ownerRepo) {
      args.push('--repo', `${ownerRepo.owner}/${ownerRepo.repo}`)
    }
    await ghExecFileAsync(args, {
      ...ghOptions,
      env: { ...process.env, GH_PROMPT_DISABLED: '1' }
    })
    invalidateReviewLookupsAfterPRMutation(repoPath, connectionId)
    return { ok: true }
  } catch (err) {
    const message =
      err instanceof Error ? err.message : typeof err === 'string' ? err : 'Unknown error'
    return { ok: false, error: message }
  } finally {
    release()
  }
}

export async function removePRReviewers(
  repoPath: string,
  prNumber: number,
  reviewers: string[],
  connectionId?: string | null,
  prRepo?: GitHubApiRepository | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<{ ok: true } | { ok: false; error: string }> {
  const logins = reviewers.map((reviewer) => reviewer.trim()).filter(Boolean)
  if (logins.length === 0) {
    return codeHostFailure('github.reviewerRequired')
  }
  const { ownerRepo, ghOptions } = await resolveGitHubRepoExecution(
    repoPath,
    prRepo,
    connectionId,
    localGitOptions
  )
  if (!ownerRepo) {
    return codeHostFailure('github.repoUnresolved')
  }
  await acquire()
  try {
    const args = ['pr', 'edit', String(prNumber), '--remove-reviewer', logins.join(',')]
    if (ownerRepo) {
      args.push('--repo', `${ownerRepo.owner}/${ownerRepo.repo}`)
    }
    await ghExecFileAsync(args, {
      ...ghOptions,
      env: { ...process.env, GH_PROMPT_DISABLED: '1' }
    })
    invalidateReviewLookupsAfterPRMutation(repoPath, connectionId)
    return { ok: true }
  } catch (err) {
    const message =
      err instanceof Error ? err.message : typeof err === 'string' ? err : 'Unknown error'
    return { ok: false, error: message }
  } finally {
    release()
  }
}
