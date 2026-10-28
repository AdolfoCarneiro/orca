import type { GitHubWorkItemDetails } from '../../../../../shared/github/work-item-types'
import {
  WORK_ITEM_DETAILS_UNAVAILABLE_MESSAGE,
  touchWorkItemDetailsCache,
  workItemDetailsCache,
  type WorkItemDetailsCacheEntry
} from './work-item-details-cache'

type FetchAcceptance = {
  accepts?: (result: GitHubWorkItemDetails | null) => boolean
  onAccepted?: (result: GitHubWorkItemDetails) => void
}
export async function settleWorkItemDetailsFetch(
  args: FetchAcceptance & {
    detailsCacheKey: string
    inflight: Promise<GitHubWorkItemDetails | null>
  }
) {
  const { detailsCacheKey, inflight } = args
  let result: GitHubWorkItemDetails | null = null
  let error: string | undefined
  try {
    result = await inflight
  } catch (err) {
    error = err instanceof Error ? err.message : 'Failed to load details'
  }
  const prev = workItemDetailsCache.get(detailsCacheKey)
  if (prev?.pending !== inflight) {
    return { status: 'superseded' } as const
  }
  try {
    if (args.accepts?.(result) === false) {
      touchWorkItemDetailsCache(detailsCacheKey, { ...prev, pending: undefined })
      return { status: 'superseded' } as const
    }
  } catch (err) {
    error = err instanceof Error ? err.message : 'Failed to load details'
    result = null
  }
  if (error || result === null) {
    // An ordinary unavailable response keeps existing detail without introducing an error.
    touchWorkItemDetailsCache(detailsCacheKey, {
      ...prev,
      pending: undefined,
      error: error ?? (prev.details ? undefined : WORK_ITEM_DETAILS_UNAVAILABLE_MESSAGE)
    })
    return { status: 'failed', error: error ?? WORK_ITEM_DETAILS_UNAVAILABLE_MESSAGE } as const
  }
  touchWorkItemDetailsCache(detailsCacheKey, {
    ...prev,
    details: result,
    pending: undefined,
    error: undefined,
    fetchedAt: Date.now()
  })
  args.onAccepted?.(result)
  return { status: 'accepted', details: result } as const
}

export function startWorkItemDetailsFetch(
  key: string,
  load: () => Promise<GitHubWorkItemDetails | null>,
  options: FetchAcceptance & {
    seed?: WorkItemDetailsCacheEntry
    route?: WorkItemDetailsCacheEntry['route']
  } = {}
) {
  const inflight = Promise.resolve().then(load)
  const previous = workItemDetailsCache.get(key) ?? options.seed
  touchWorkItemDetailsCache(key, {
    details: previous?.details ?? null,
    fetchedAt: previous?.fetchedAt ?? 0,
    pending: inflight,
    route: options.route ?? previous?.route
  })
  const settled = settleWorkItemDetailsFetch({ ...options, detailsCacheKey: key, inflight })
  return {
    settled,
    cancel() {
      const current = workItemDetailsCache.get(key)
      if (current?.pending === inflight) {
        touchWorkItemDetailsCache(key, { ...current, pending: undefined })
      }
    }
  }
}
