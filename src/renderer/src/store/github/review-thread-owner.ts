import type { ExecutionHostId } from '../../../../shared/execution-host'
import { getRepoExecutionHostId, normalizeExecutionHostId } from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import type { AppState } from '../types'
import { findRepoForHost } from '../slices/repo-host-identity'
import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'

export type GitHubReviewThreadOwnerOptions = {
  repoId?: string
  sourceContext?: TaskSourceContext | null
  /** A real GitHub sourceContext takes precedence over this selected repo owner. */
  repoOwnerExecutionHostId?: ExecutionHostId
}

export function githubReviewThreadOwner(
  state: Pick<AppState, 'repos'>,
  repoPath: string,
  options?: GitHubReviewThreadOwnerOptions
): { ok: true; repo: Repo | undefined } | { ok: false } {
  const candidates = (state.repos ?? []).filter(
    (repo) => !options?.repoId || repo.id === options.repoId
  )
  const path = normalizeRuntimePathForComparison(repoPath)
  const rows = candidates.filter((repo) => normalizeRuntimePathForComparison(repo.path) === path)
  if (options?.sourceContext?.provider === 'github') {
    const sourceRows = rows.filter(
      (repo) => getRepoExecutionHostId(repo) === options.sourceContext?.hostId
    )
    // Source contexts may name an unlisted runtime repo or inherit a unique repo's owner.
    const uniqueRepo =
      rows.length === 1 ? rows[0] : candidates.length === 1 ? candidates[0] : undefined
    return { ok: true, repo: sourceRows.length === 1 ? sourceRows[0] : uniqueRepo }
  }
  if (options?.repoOwnerExecutionHostId !== undefined) {
    const hostId = normalizeExecutionHostId(options.repoOwnerExecutionHostId)
    if (!hostId) {
      return { ok: false }
    }
    const ownedRows = rows.filter((repo) => getRepoExecutionHostId(repo) === hostId)
    const repoId = options.repoId ?? ownedRows[0]?.id
    if (!repoId) {
      return { ok: false }
    }
    const repo = findRepoForHost(ownedRows, repoId, { hostId })
    return ownedRows.length === 1 && repo ? { ok: true, repo } : { ok: false }
  }
  return rows.length === 1 ? { ok: true, repo: rows[0] } : { ok: false }
}
