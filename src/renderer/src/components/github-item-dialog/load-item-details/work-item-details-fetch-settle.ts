import {
  GitHubWorkItemTargetError,
  requireGitHubWorkItemTargetDetails,
  type GitHubWorkItemTarget
} from '../../../../../shared/github/work-item-target'
import type { GitHubWorkItemDetails } from '../../../../../shared/github/work-item-types'
import {
  WORK_ITEM_DETAILS_UNAVAILABLE_MESSAGE,
  touchWorkItemDetailsCache,
  workItemDetailsCache,
  workItemDetailsCacheGeneration
} from './work-item-details-cache'

export function settleWorkItemDetailsFetch(args: {
  detailsCacheKey: string
  inflight: Promise<GitHubWorkItemDetails | null>
  launchedAtGeneration: number
  target?: GitHubWorkItemTarget | null
}): void {
  const { detailsCacheKey, inflight, launchedAtGeneration } = args
  void inflight
    .then((result) => {
      if (args.target) {
        requireGitHubWorkItemTargetDetails(result, args.target)
      }
      const invalidatedMidFlight = workItemDetailsCacheGeneration !== launchedAtGeneration
      const prev = workItemDetailsCache.get(detailsCacheKey)
      if (invalidatedMidFlight && prev?.pending !== inflight) {
        // Do not recreate or touch entries deliberately invalidated or replaced during this fetch.
        return
      }
      // Why: null means unavailable/not found, not loaded empty content.
      if (result === null && prev?.details) {
        touchWorkItemDetailsCache(detailsCacheKey, {
          details: prev.details,
          fetchedAt: prev.fetchedAt,
          error: undefined
        })
      } else if (result === null) {
        touchWorkItemDetailsCache(detailsCacheKey, {
          details: null,
          fetchedAt: 0,
          error: WORK_ITEM_DETAILS_UNAVAILABLE_MESSAGE
        })
      } else {
        touchWorkItemDetailsCache(detailsCacheKey, {
          details: result,
          fetchedAt: Date.now(),
          error: undefined
        })
      }
    })
    .catch((err) => {
      const message = err instanceof Error ? err.message : 'Failed to load details'
      const invalidatedMidFlight = workItemDetailsCacheGeneration !== launchedAtGeneration
      const prev = workItemDetailsCache.get(detailsCacheKey)
      if (invalidatedMidFlight && prev?.pending !== inflight) {
        return
      }
      // Keep cached details on error, but drop the pending promise so later opens can retry.
      touchWorkItemDetailsCache(detailsCacheKey, {
        details: err instanceof GitHubWorkItemTargetError ? null : (prev?.details ?? null),
        fetchedAt: err instanceof GitHubWorkItemTargetError ? 0 : (prev?.fetchedAt ?? 0),
        error: message
      })
    })
}
