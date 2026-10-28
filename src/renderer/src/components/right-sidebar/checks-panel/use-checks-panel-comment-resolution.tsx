import { useMountedRef } from '@/hooks/useMountedRef'
import { useAgentMenuObservation } from '@/components/tab-bar/use-new-tab-agent-menu-rows'
import { useAgentDetectionTargetForWorktree } from '@/hooks/useAgentDetectionTarget'
import { resolveChecksActionAgent } from '@/lib/source-control-agent-picker'
import type { SourceControlActionId } from '../../../../../shared/source-control-ai-actions'
import { forgeOwnerHostIdForWorkspace } from '@/runtime/forge-credential-target'
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { toast } from 'sonner'
import {
  markPRCommentThreadResolved,
  restorePRCommentThreadSnapshot
} from '../pr-comment-thread-resolution'
import type { ChecksPanelControllerState } from './use-checks-panel-controller-state'
import type { ChecksPanelContextState } from './use-checks-panel-context-state'
import type { ChecksPanelReviewState } from './use-checks-panel-review-state'
import {
  gitlabReviewThreadRequest,
  resolveGitlabReviewThread
} from '@/runtime/review-thread-resolution'
import { githubReviewThreadRequest } from '@/store/github/review-thread-request'
import {
  acquireReviewThreadResolution,
  releaseReviewThreadResolution
} from '@/lib/review-thread-resolution-pending'
import { clearPendingPRCommentAiAck } from '../pr-comments-ai-launch-ack'
import type { PRComment } from '../../../../../shared/github/comment-types'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { worktreeLaunchWorkspace } from '@/lib/agent-launch-route-input'

type ChecksPanelCommentResolutionInput = Pick<
  ChecksPanelControllerState,
  | 'activeWorktree'
  | 'activeWorktreeId'
  | 'claimedCommentResolutionRef'
  | 'commentResolutionAckBusy'
  | 'commentsLoading'
  | 'detectedAgentIds'
  | 'pendingCommentResolutionRef'
  | 'repo'
  | 'resolveReviewThread'
  | 'setAgentComposerState'
  | 'setComments'
  | 'settings'
  | 'commentResolutionLaunchAcceptedRef'
> &
  Pick<ChecksPanelContextState, 'activeGitLabReview' | 'activeReview' | 'pr' | 'prNumber'> &
  Pick<ChecksPanelReviewState, 'sourceControlAiActionsVisible'>

export function useChecksPanelCommentResolution(model: ChecksPanelCommentResolutionInput) {
  const {
    activeGitLabReview,
    activeReview,
    activeWorktree,
    activeWorktreeId,
    claimedCommentResolutionRef,
    commentResolutionAckBusy,
    commentsLoading,
    detectedAgentIds,
    pendingCommentResolutionRef,
    pr,
    prNumber,
    repo,
    resolveReviewThread,
    setAgentComposerState,
    setComments,
    sourceControlAiActionsVisible,
    commentResolutionLaunchAcceptedRef
  } = model
  const getThreadResolutionKey = useCallback(
    (threadId: string): string | undefined => {
      if (!repo) {
        return undefined
      }
      if (activeGitLabReview) {
        return gitlabReviewThreadRequest(
          {
            repoPath: repo.path,
            repoId: repo.id,
            repoOwnerExecutionHostId: forgeOwnerHostIdForWorkspace(repo, activeWorktree)
          },
          activeGitLabReview.number,
          threadId
        ).key
      }
      return prNumber
        ? githubReviewThreadRequest(useAppStore.getState(), repo.path, prNumber, threadId, {
            repoId: repo.id,
            prRepo: pr?.prRepo
          }).key
        : undefined
    },
    [repo, activeGitLabReview, activeWorktree, prNumber, pr?.prRepo]
  )
  const mountedRef = useMountedRef()
  const currentThreadResolutionKey = useRef(getThreadResolutionKey)
  useLayoutEffect(() => {
    currentThreadResolutionKey.current = getThreadResolutionKey
  }, [getThreadResolutionKey])
  const handleResolve = useCallback(
    async (
      threadId: string,
      resolve: boolean,
      options: { notifyOnFailure?: boolean } = {}
    ): Promise<boolean> => {
      if (!repo || (!activeGitLabReview && !prNumber)) {
        return false
      }
      const githubRequest =
        !activeGitLabReview && prNumber
          ? githubReviewThreadRequest(useAppStore.getState(), repo.path, prNumber, threadId, {
              repoId: repo.id,
              prRepo: pr?.prRepo
            })
          : null
      const gitlabRequest = activeGitLabReview
        ? gitlabReviewThreadRequest(
            {
              repoPath: repo.path,
              repoId: repo.id,
              repoOwnerExecutionHostId: forgeOwnerHostIdForWorkspace(repo, activeWorktree)
            },
            activeGitLabReview.number,
            threadId
          )
        : null
      const key = githubRequest?.key ?? gitlabRequest?.key
      if (!key) {
        return false
      }
      const owner = acquireReviewThreadResolution(key)
      if (!owner) {
        return false
      }
      let previousThreadComments: PRComment[] = []
      const isCurrentTarget = (): boolean =>
        mountedRef.current && currentThreadResolutionKey.current(threadId) === key
      const rollback = (): void => {
        if (isCurrentTarget()) {
          setComments((current) => restorePRCommentThreadSnapshot(current, previousThreadComments))
        }
      }
      const notifyOnFailure = options.notifyOnFailure !== false
      try {
        setComments((previous) => {
          previousThreadComments = previous.filter((comment) => comment.threadId === threadId)
          return markPRCommentThreadResolved(previous, threadId, resolve)
        })
        if (gitlabRequest) {
          const result = await resolveGitlabReviewThread(gitlabRequest, resolve, owner)
          if (result === 'busy') {
            rollback()
            return false
          }
          if (!result.ok) {
            rollback()
            if (notifyOnFailure) {
              toast.error(result.error)
            }
          }
          return result.ok
        }
        if (!githubRequest) {
          return false
        }
        const result = await resolveReviewThread(
          repo.path,
          githubRequest.prNumber,
          threadId,
          resolve,
          {
            repoId: repo.id,
            prRepo: githubRequest.prRepo,
            threadResolutionAdmission: { owner, request: githubRequest }
          }
        )
        if (result !== true) {
          rollback()
          if (result !== 'busy' && notifyOnFailure) {
            toast.error(
              translate(
                'auto.components.right.sidebar.ChecksPanel.5788d1059d',
                'Could not update review thread. Check the GitHub API budget.'
              )
            )
          }
        }
        return result === true
      } catch (error) {
        rollback()
        if (notifyOnFailure) {
          toast.error(error instanceof Error ? error.message : String(error))
        }
        return false
      } finally {
        releaseReviewThreadResolution(owner)
      }
    },
    [
      activeGitLabReview,
      pr?.prRepo,
      prNumber,
      repo,
      resolveReviewThread,
      activeWorktree,
      setComments,
      mountedRef
    ]
  )

  const canTargetPRComments = Boolean(repo && prNumber && pr?.prRepo)
  const commentsDisabledReason = canTargetPRComments
    ? undefined
    : 'Commenting requires a GitHub PR repository target.'
  const workspace = worktreeLaunchWorkspace(activeWorktreeId ?? '')
  const observation = useAgentMenuObservation(
    activeWorktreeId,
    sourceControlAiActionsVisible,
    useAgentDetectionTargetForWorktree(activeWorktreeId)
  )
  const launchState = useAppStore.getState()
  const noAgentFor = (actionId: SourceControlActionId): boolean =>
    !observation.preferencesPending &&
    detectedAgentIds != null &&
    resolveChecksActionAgent(
      launchState,
      actionId,
      repo?.id,
      workspace,
      detectedAgentIds,
      observation.preferences
    ) == null
  const noEnabledAgentKnown = noAgentFor('resolveConflicts')
  const actionDisabledReason = (actionId: SourceControlActionId): string | undefined =>
    !activeWorktreeId
      ? 'Select a workspace before launching an AI action.'
      : noAgentFor(actionId)
        ? 'No enabled AI agents. Configure agents in Settings.'
        : undefined
  const aiActionDisabledReason = actionDisabledReason('resolveConflicts')
  const fixChecksDisabledReason = actionDisabledReason('fixChecks')
  useEffect(() => {
    if (!sourceControlAiActionsVisible) {
      setAgentComposerState(null)
      pendingCommentResolutionRef.current = null
      claimedCommentResolutionRef.current = null
      commentResolutionLaunchAcceptedRef.current = false
      clearPendingPRCommentAiAck()
    }
  }, [
    sourceControlAiActionsVisible,
    claimedCommentResolutionRef,
    pendingCommentResolutionRef,
    commentResolutionLaunchAcceptedRef,
    setAgentComposerState
  ])
  const resolveCommentsWithAIDisabledReason = commentResolutionAckBusy
    ? 'Still finishing the previous comment launch.'
    : commentsLoading
      ? 'Comments are still loading.'
      : actionDisabledReason('resolveComments')
        ? actionDisabledReason('resolveComments')
        : !activeReview
          ? 'Open a PR or MR before launching an AI action.'
          : !repo
            ? 'Select a repository before launching an AI action.'
            : activeReview.provider === 'github' && !prNumber
              ? 'Open a GitHub PR before resolving comments.'
              : activeReview.provider === 'gitlab' && !activeGitLabReview
                ? 'Open a GitLab MR before resolving comments.'
                : undefined
  return {
    handleResolve,
    getThreadResolutionKey,
    canTargetPRComments,
    commentsDisabledReason,
    detectedAgentsForAI: detectedAgentIds,
    noEnabledAgentKnown,
    aiActionDisabledReason,
    fixChecksDisabledReason,
    resolveCommentsWithAIDisabledReason
  }
}

export type ChecksPanelCommentResolutionState = ReturnType<typeof useChecksPanelCommentResolution>
