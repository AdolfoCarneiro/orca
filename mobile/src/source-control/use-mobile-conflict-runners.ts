import { useCallback } from 'react'
import type { ConflictResolution } from '../../../src/shared/source-control-entry-actions'
import { isMobileGitUnavailable } from './mobile-git-status'
import {
  MOBILE_COMPLETE_MERGE_ACTION_ID,
  MOBILE_CONFLICT_NEEDS_NEWER_HOST_MESSAGE
} from './mobile-source-control-conflict-actions'
import type {
  GitCommitResult,
  GitRequestError,
  MobileGitStatusEntryView
} from './mobile-source-control-screen-state'

type SendGitRequest = <T>(method: string, params?: Record<string, unknown>) => Promise<T>

type Params = {
  sendGitRequest: SendGitRequest
  runGitAction: (actionId: string, method: string, p: Record<string, unknown>) => Promise<boolean>
  runGitWorkflow: (actionId: string, runner: () => Promise<void>) => Promise<boolean>
}

/** Abort, resolve and complete a paused merge through the host ops desktop uses. */
export function useMobileConflictRunners({ sendGitRequest, runGitAction, runGitWorkflow }: Params) {
  // Hosts older than these ops refuse them; say what to do instead of echoing the raw refusal.
  const sendConflictRequest = useCallback(
    async <T>(method: string, params?: Record<string, unknown>): Promise<T> => {
      try {
        return await sendGitRequest<T>(method, params)
      } catch (err) {
        const code = err instanceof Error ? (err as GitRequestError).code : undefined
        if (isMobileGitUnavailable(code, err instanceof Error ? err.message : undefined)) {
          throw new Error(MOBILE_CONFLICT_NEEDS_NEWER_HOST_MESSAGE)
        }
        throw err
      }
    },
    [sendGitRequest]
  )

  const abortConflictOperation = useCallback(
    async (operation: string) => {
      const method =
        operation === 'merge' ? 'git.abortMerge' : operation === 'rebase' ? 'git.abortRebase' : null
      if (!method) {
        return
      }
      await runGitAction(`abort-${operation}`, method, {})
    },
    [runGitAction]
  )

  const resolveConflict = useCallback(
    async (entry: MobileGitStatusEntryView, resolution: ConflictResolution) => {
      await runGitWorkflow(entry.resolveActionId, async () => {
        await sendConflictRequest<unknown>('git.resolveConflict', {
          filePath: entry.path,
          resolution
        })
      })
    },
    [runGitWorkflow, sendConflictRequest]
  )

  const completeMerge = useCallback(async () => {
    await runGitWorkflow(MOBILE_COMPLETE_MERGE_ACTION_ID, async () => {
      // completeMerge reports Git's refusal in-band, like git.commit.
      const result = await sendConflictRequest<GitCommitResult>('git.completeMerge')
      if (!result || result.success !== true) {
        throw new Error(result?.error || 'Complete merge failed')
      }
    })
  }, [runGitWorkflow, sendConflictRequest])

  return { abortConflictOperation, resolveConflict, completeMerge }
}
