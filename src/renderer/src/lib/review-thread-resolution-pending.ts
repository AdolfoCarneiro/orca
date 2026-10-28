import { useCallback, useMemo, useSyncExternalStore } from 'react'

export type ReviewThreadResolutionOwner = { readonly key: string }
export type ReviewThreadResolutionResult = boolean | 'busy'

const pending = new Map<string, { owner: ReviewThreadResolutionOwner; dispatched: boolean }>()
const listeners = new Map<string, Set<() => void>>()

function emit(key: string): void {
  for (const listener of listeners.get(key) ?? []) {
    listener()
  }
}

export function acquireReviewThreadResolution(key: string): ReviewThreadResolutionOwner | null {
  if (pending.has(key)) {
    return null
  }
  const owner = Object.freeze({ key })
  pending.set(key, { owner, dispatched: false })
  emit(key)
  return owner
}

export function adoptReviewThreadResolution(
  key: string,
  owner: ReviewThreadResolutionOwner
): boolean {
  const entry = pending.get(key)
  if (entry?.owner !== owner || entry.dispatched) {
    return false
  }
  entry.dispatched = true
  return true
}

export function releaseReviewThreadResolution(owner: ReviewThreadResolutionOwner): void {
  if (pending.get(owner.key)?.owner !== owner) {
    return
  }
  pending.delete(owner.key)
  emit(owner.key)
}

function subscribeKey(key: string, listener: () => void): () => void {
  let subscribers = listeners.get(key)
  if (!subscribers) {
    subscribers = new Set()
    listeners.set(key, subscribers)
  }
  subscribers.add(listener)
  return () => {
    subscribers.delete(listener)
    if (subscribers.size === 0) {
      listeners.delete(key)
    }
  }
}

export function useReviewThreadResolutionPending(key: string | undefined): boolean {
  const subscribe = useCallback(
    (listener: () => void) => (key === undefined ? () => {} : subscribeKey(key, listener)),
    [key]
  )
  const snapshot = useCallback(() => key !== undefined && pending.has(key), [key])
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

export function usePendingReviewThreadResolutionKeys(keys: readonly string[]): ReadonlySet<string> {
  const subscribe = useCallback(
    (listener: () => void) => {
      const unsubscribe = keys.map((key) => subscribeKey(key, listener))
      return () => unsubscribe.forEach((remove) => remove())
    },
    [keys]
  )
  const snapshot = useCallback(
    () => keys.map((key) => (pending.has(key) ? '1' : '0')).join(''),
    [keys]
  )
  const value = useSyncExternalStore(subscribe, snapshot, snapshot)
  return useMemo(() => new Set(keys.filter((_, index) => value[index] === '1')), [keys, value])
}
