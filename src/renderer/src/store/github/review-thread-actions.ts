import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { GitHubSlice } from './slice-types'
import { callRuntimeRpc } from '../../runtime/runtime-rpc-client'
import { prCommentsCacheSuffix, sourceScopedRepoCacheKey } from './cache-identity'
import { githubPRCommentOwner } from './pr-comment-owner'
import {
  getGitHubRepoSourceSettings,
  getGitHubSourceTarget,
  getGitHubWorkItemRequestContext
} from './work-item-routing'

export const createReviewThreadActions = (
  set: Parameters<StateCreator<AppState>>[0],
  get: Parameters<StateCreator<AppState>>[1]
): Pick<GitHubSlice, 'resolveReviewThread'> => ({
  resolveReviewThread: async (repoPath, prNumber, threadId, resolve, options) => {
    const owner = githubPRCommentOwner(get(), repoPath, options)
    if (!owner.ok) {
      return false
    }
    const { repo } = owner
    const repoId = options?.repoId ?? repo?.id
    const requestSettings = getGitHubRepoSourceSettings(get(), repo, options?.sourceContext)
    const cacheKey = sourceScopedRepoCacheKey(
      repoPath,
      repoId,
      prCommentsCacheSuffix(prNumber, options?.prRepo),
      requestSettings,
      repo?.connectionId,
      repo?.executionHostId,
      options?.sourceContext,
      repo !== undefined
    )
    const requestContext = getGitHubWorkItemRequestContext(
      get(),
      getGitHubSourceTarget(get(), repo, options?.sourceContext),
      repoId ?? repoPath,
      repoPath,
      options?.sourceContext
    )

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
        requestContext.target.kind === 'environment'
          ? await callRuntimeRpc<boolean>(
              { kind: 'environment', environmentId: requestContext.target.environmentId },
              'github.resolveReviewThread',
              {
                repo: requestContext.target.runtimeRepoId,
                threadId,
                resolve,
                prRepo: options?.prRepo ?? null
              },
              { timeoutMs: 30_000 }
            )
          : await window.api.gh.resolveReviewThread({
              repoPath,
              repoId,
              threadId,
              resolve,
              prRepo: options?.prRepo ?? null,
              sourceContext: options?.sourceContext,
              ...(options?.repoOwnerExecutionHostId
                ? { repoOwnerExecutionHostId: options.repoOwnerExecutionHostId }
                : {})
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
  }
})
