import { useCallback, useLayoutEffect, useRef } from 'react'
import { toast } from 'sonner'
import { mergePRCommentIntoList } from '@/store/github/pr-comment-cache'
import { githubProjectHost } from '../../../../../shared/github/project-identity'
import { setReactionOnSubject, restoreReactionOnSubject } from '@/lib/pr-comment-reactions'
import { buildPRCommentConversationReplyBody } from '../pr-comment-fixing-reply-body'
import {
  attachPRReviewReplyParent,
  canPostPRReviewThreadReply,
  resolvePRReviewReplyThreadId
} from '../pr-comments-ai-launch-ack'
import type { ChecksPanelControllerState } from './use-checks-panel-controller-state'
import type { ChecksPanelCommentResolutionState } from './use-checks-panel-comment-resolution'
import type { ChecksPanelComposerState } from './use-checks-panel-composer-state'
import type { ChecksPanelContextState } from './use-checks-panel-context-state'
import { checksPanelAsyncResultKey } from '../checks-panel-async-result-key'
import { isMutablePRConversationComment } from '../../../../../shared/github/pr-comment-mutability'
import type { GitHubReactionContent, PRComment } from '../../../../../shared/github/comment-types'
import { translate } from '@/i18n/i18n'
import { normalizeExecutionHostId } from '../../../../../shared/execution-host'
import { forgeOwnerHostIdForWorkspace } from '@/runtime/forge-credential-target'
import { githubPRCommentOwner } from '@/store/github/pr-comment-owner'
import { useAppStore } from '@/store'

type ChecksPanelCommentMutationsInput = Pick<
  ChecksPanelControllerState,
  | 'addPRConversationComment'
  | 'addPRReviewCommentReply'
  | 'activeWorktree'
  | 'branch'
  | 'commentsRef'
  | 'confirm'
  | 'repo'
  | 'setComments'
  | 'setPRCommentReaction'
> &
  Pick<ChecksPanelCommentResolutionState, 'commentsDisabledReason'> &
  Pick<ChecksPanelComposerState, 'isCurrentAsyncResult'> &
  Pick<ChecksPanelContextState, 'pr' | 'prCacheKey' | 'prNumber'>

export function useChecksPanelCommentMutations(model: ChecksPanelCommentMutationsInput) {
  const {
    addPRConversationComment,
    addPRReviewCommentReply,
    activeWorktree,
    branch,
    commentsDisabledReason,
    commentsRef,
    confirm,
    isCurrentAsyncResult,
    pr,
    prCacheKey,
    prNumber,
    repo,
    setComments,
    setPRCommentReaction
  } = model
  const selectedOwnerHostId = repo
    ? normalizeExecutionHostId(forgeOwnerHostIdForWorkspace(repo, activeWorktree))
    : null
  const currentOwnerHostId = useRef(selectedOwnerHostId)
  useLayoutEffect(() => {
    currentOwnerHostId.current = selectedOwnerHostId
    return () => {
      currentOwnerHostId.current = null
    }
  }, [selectedOwnerHostId])
  const getCommentOwnerOptions = useCallback(() => {
    if (!repo || !selectedOwnerHostId) {
      return null
    }
    const options = { repoId: repo.id, repoOwnerExecutionHostId: selectedOwnerHostId }
    return githubPRCommentOwner(useAppStore.getState(), repo.path, options).ok ? options : null
  }, [repo, selectedOwnerHostId])
  const isCurrentCommentTarget = useCallback(
    (requestKey: string) =>
      currentOwnerHostId.current !== null &&
      currentOwnerHostId.current === selectedOwnerHostId &&
      isCurrentAsyncResult(requestKey),
    [selectedOwnerHostId, isCurrentAsyncResult]
  )
  const ownerUnavailableError = translate(
    'auto.runtime.forgeCredentialTarget.unknownHost',
    'The machine that owns this repository is not known yet. Reconnect it and try again.'
  )
  const handleAddPRComment = useCallback(
    async (body: string) => {
      if (!repo || !prNumber || !pr?.prRepo) {
        return { ok: false as const, error: commentsDisabledReason ?? 'Commenting unavailable.' }
      }
      const ownerOptions = getCommentOwnerOptions()
      if (!ownerOptions) {
        toast.error(ownerUnavailableError)
        return { ok: false as const, error: ownerUnavailableError }
      }
      const requestKey = checksPanelAsyncResultKey(
        prCacheKey,
        branch,
        prNumber,
        pr.prRepo,
        pr.headSha
      )
      const result = await addPRConversationComment(repo.path, prNumber, body, {
        ...ownerOptions,
        prRepo: pr.prRepo
      })
      if (!result.ok) {
        toast.error(result.error)
        return result
      }
      if (!isCurrentCommentTarget(requestKey)) {
        return { ok: true as const }
      }
      setComments((prev) => mergePRCommentIntoList(prev, result.comment))
      return { ok: true as const }
    },
    [
      addPRConversationComment,
      branch,
      commentsDisabledReason,
      getCommentOwnerOptions,
      isCurrentCommentTarget,
      ownerUnavailableError,
      pr,
      prCacheKey,
      prNumber,
      repo,
      setComments
    ]
  )

  const handleEditComment = useCallback(
    async (comment: PRComment, body: string): Promise<boolean> => {
      if (!pr?.prRepo || !isMutablePRConversationComment(comment)) {
        return false
      }
      const result = await window.api.gh.updateIssueCommentBySlug({
        owner: pr.prRepo.owner,
        repo: pr.prRepo.repo,
        host: githubProjectHost(pr.prRepo.host),
        commentId: comment.id,
        body
      })
      if (!result.ok) {
        toast.error(result.error.message)
        return false
      }
      setComments((prev) =>
        prev.map((entry) => (entry.id === comment.id ? { ...entry, body } : entry))
      )
      return true
    },
    [pr?.prRepo, setComments]
  )

  const handleDeleteComment = useCallback(
    async (comment: PRComment): Promise<void> => {
      if (!pr?.prRepo || !isMutablePRConversationComment(comment)) {
        return
      }
      const confirmed = await confirm({
        title: translate('auto.components.right.sidebar.ChecksPanel.ea9b649ce3', 'Delete comment?'),
        description: translate(
          'auto.components.right.sidebar.ChecksPanel.3b203c62f8',
          'This will permanently remove the comment from the PR.'
        ),
        confirmLabel: translate('auto.components.right.sidebar.ChecksPanel.786e3c143f', 'Delete'),
        confirmVariant: 'destructive'
      })
      if (!confirmed) {
        return
      }
      const result = await window.api.gh.deleteIssueCommentBySlug({
        owner: pr.prRepo.owner,
        repo: pr.prRepo.repo,
        host: githubProjectHost(pr.prRepo.host),
        commentId: comment.id
      })
      if (!result.ok) {
        toast.error(result.error.message)
        return
      }
      setComments((prev) => prev.filter((entry) => entry.id !== comment.id))
    },
    [pr?.prRepo, confirm, setComments]
  )

  const handleSetReaction = useCallback(
    async (
      comment: PRComment,
      content: GitHubReactionContent,
      reacted: boolean
    ): Promise<boolean> => {
      const reactionSubjectId = comment.reactionSubjectId
      if (!repo || !prNumber || !pr?.prRepo || !reactionSubjectId) {
        return false
      }
      const ownerOptions = getCommentOwnerOptions()
      if (!ownerOptions) {
        toast.error(ownerUnavailableError)
        return false
      }
      const requestKey = checksPanelAsyncResultKey(
        prCacheKey,
        branch,
        prNumber,
        pr.prRepo,
        pr.headSha
      )
      const previousReaction = comment.reactions?.find((reaction) => reaction.content === content)
      setComments((current) => setReactionOnSubject(current, reactionSubjectId, content, reacted))
      const ok = await setPRCommentReaction(
        repo.path,
        prNumber,
        reactionSubjectId,
        content,
        reacted,
        { ...ownerOptions, prRepo: pr.prRepo }
      )
      if (ok) {
        return true
      }
      if (isCurrentCommentTarget(requestKey)) {
        setComments((current) =>
          restoreReactionOnSubject(current, reactionSubjectId, content, previousReaction)
        )
      }
      toast.error(
        translate(
          'auto.components.right.sidebar.ChecksPanel.updateReactionFailed',
          'Failed to update reaction.'
        )
      )
      return false
    },
    [
      branch,
      getCommentOwnerOptions,
      isCurrentCommentTarget,
      ownerUnavailableError,
      pr,
      prCacheKey,
      prNumber,
      repo,
      setPRCommentReaction,
      setComments
    ]
  )

  const handleReplyToComment = useCallback(
    async (comment: PRComment, body: string, options: { notifyOnFailure?: boolean } = {}) => {
      const notifyOnFailure = options.notifyOnFailure !== false
      if (!repo || !prNumber || !pr?.prRepo) {
        return { ok: false as const, error: commentsDisabledReason ?? 'Commenting unavailable.' }
      }
      const ownerOptions = getCommentOwnerOptions()
      if (!ownerOptions) {
        if (notifyOnFailure) {
          toast.error(ownerUnavailableError)
        }
        return { ok: false as const, error: ownerUnavailableError }
      }
      const requestKey = checksPanelAsyncResultKey(
        prCacheKey,
        branch,
        prNumber,
        pr.prRepo,
        pr.headSha
      )
      // Prefer nested replies for review comments; GitHub conversation comments support only top-level posts.
      const parentThreadId =
        resolvePRReviewReplyThreadId({
          parent: comment,
          existingComments: commentsRef.current
        }) ?? comment.threadId
      const result = canPostPRReviewThreadReply(comment)
        ? await addPRReviewCommentReply(repo.path, prNumber, comment.id, body, {
            ...ownerOptions,
            prRepo: pr.prRepo,
            threadId: parentThreadId,
            path: comment.path,
            line: comment.line
          })
        : await addPRConversationComment(
            repo.path,
            prNumber,
            buildPRCommentConversationReplyBody(comment.author, body),
            {
              ...ownerOptions,
              prRepo: pr.prRepo
            }
          )
      if (!result.ok) {
        if (notifyOnFailure) {
          toast.error(result.error)
        }
        return result
      }
      if (!isCurrentCommentTarget(requestKey)) {
        return { ok: true as const }
      }
      // Restore omitted threadId/path on review replies so the sidebar retains parent grouping.
      const mergedComment = canPostPRReviewThreadReply(comment)
        ? attachPRReviewReplyParent(result.comment, {
            ...comment,
            threadId: parentThreadId
          })
        : result.comment
      setComments((prev) => mergePRCommentIntoList(prev, mergedComment))
      return { ok: true as const }
    },
    [
      addPRConversationComment,
      addPRReviewCommentReply,
      branch,
      commentsDisabledReason,
      getCommentOwnerOptions,
      isCurrentCommentTarget,
      ownerUnavailableError,
      pr,
      prCacheKey,
      prNumber,
      repo,
      setComments,
      commentsRef
    ]
  )
  return {
    handleAddPRComment,
    handleEditComment,
    handleDeleteComment,
    handleSetReaction,
    handleReplyToComment
  }
}

export type ChecksPanelCommentMutationState = ReturnType<typeof useChecksPanelCommentMutations>
