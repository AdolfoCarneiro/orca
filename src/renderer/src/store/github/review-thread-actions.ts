import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { GitHubSlice } from './slice-types'
import { callRuntimeRpc } from '../../runtime/runtime-rpc-client'
import { githubReviewThreadRequest } from './review-thread-request'
import {
  acquireReviewThreadResolution,
  adoptReviewThreadResolution,
  releaseReviewThreadResolution
} from '@/lib/review-thread-resolution-pending'

export const createReviewThreadActions = (
  set: Parameters<StateCreator<AppState>>[0],
  get: Parameters<StateCreator<AppState>>[1]
): Pick<GitHubSlice, 'resolveReviewThread'> => ({
  resolveReviewThread: async (repoPath, prNumber, threadId, resolve, options) => {
    const admission = options?.threadResolutionAdmission
    const request =
      admission?.request ?? githubReviewThreadRequest(get(), repoPath, prNumber, threadId, options)
    if (
      request.repoPath !== repoPath ||
      request.prNumber !== prNumber ||
      request.threadId !== threadId
    ) {
      return 'busy'
    }
    const owner = admission?.owner ?? acquireReviewThreadResolution(request.key)
    if (!owner || !adoptReviewThreadResolution(request.key, owner)) {
      return 'busy'
    }
    const { cacheKey, repoId } = request
    try {
      // Optimistic toggle of isResolved for this thread; reverts if the API call fails.
      const prev = get().commentsCache[cacheKey]?.data
      if (prev) {
        set((s) => ({
          commentsCache: {
            ...s.commentsCache,
            [cacheKey]: {
              ...s.commentsCache[cacheKey],
              data: prev.map((c) => (c.threadId === threadId ? { ...c, isResolved: resolve } : c))
            }
          }
        }))
      }

      let ok = false
      try {
        ok =
          request.target.kind === 'environment'
            ? await callRuntimeRpc<boolean>(
                { kind: 'environment', environmentId: request.target.environmentId },
                'github.resolveReviewThread',
                {
                  repo: request.target.runtimeRepoId,
                  threadId,
                  resolve,
                  prRepo: request.prRepo ?? null
                },
                { timeoutMs: 30_000 }
              )
            : await window.api.gh.resolveReviewThread({
                repoPath,
                repoId,
                threadId,
                resolve,
                prRepo: request.prRepo ?? null,
                sourceContext: request.sourceContext
              })
      } catch (err) {
        console.error('Failed to update review thread:', err)
        ok = false
      }
      if (!ok && prev) {
        set((s) => ({
          commentsCache: {
            ...s.commentsCache,
            [cacheKey]: { ...s.commentsCache[cacheKey], data: prev }
          }
        }))
      }
      return ok
    } finally {
      if (!admission) {
        releaseReviewThreadResolution(owner)
      }
    }
  }
})
