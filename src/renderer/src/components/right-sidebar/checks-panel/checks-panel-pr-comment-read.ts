import { normalizeExecutionHostId } from '../../../../../shared/execution-host'
import type { PRInfo } from '../../../../../shared/github/pull-request-types'
import { forgeOwnerHostIdForWorkspace } from '@/runtime/forge-credential-target'
import type { ChecksPanelControllerState } from './use-checks-panel-controller-state'

export function fetchChecksPanelPRComments(
  {
    repo,
    activeWorktree,
    fetchPRComments
  }: Pick<ChecksPanelControllerState, 'repo' | 'activeWorktree' | 'fetchPRComments'>,
  pr: PRInfo
) {
  const repoOwnerExecutionHostId = repo
    ? normalizeExecutionHostId(forgeOwnerHostIdForWorkspace(repo, activeWorktree))
    : null
  return repo && repoOwnerExecutionHostId
    ? fetchPRComments(repo.path, pr.number, {
        force: true,
        repoId: repo.id,
        prRepo: pr.prRepo,
        repoOwnerExecutionHostId
      })
    : Promise.resolve([])
}

export function refreshChecksPanelPRComments(
  model: Pick<
    ChecksPanelControllerState,
    'repo' | 'activeWorktree' | 'fetchPRComments' | 'setComments' | 'setCommentsLoading'
  > & { isCurrent: () => boolean },
  pr: PRInfo
) {
  model.setCommentsLoading(true)
  return fetchChecksPanelPRComments(model, pr)
    .then(
      (comments) => {
        if (model.isCurrent()) {
          model.setComments(comments)
        }
      },
      (error) => {
        if (model.isCurrent()) {
          console.warn('Failed to fetch PR comments:', error)
          model.setComments([])
        }
      }
    )
    .finally(() => {
      if (model.isCurrent()) {
        model.setCommentsLoading(false)
      }
    })
}
