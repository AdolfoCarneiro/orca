// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import {
  acquireReviewThreadResolution,
  adoptReviewThreadResolution,
  releaseReviewThreadResolution,
  useReviewThreadResolutionPending,
  type ReviewThreadResolutionOwner
} from './review-thread-resolution-pending'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
afterEach(cleanup)

it('keeps a live keyed subscriber across settlement and retry and isolates unrelated threads', () => {
  const first = renderHook(() => useReviewThreadResolutionPending('subscribed-thread'))
  const unrelated = renderHook(() => useReviewThreadResolutionPending('unrelated-thread'))
  const acquire = () => {
    const acquired: ReviewThreadResolutionOwner[] = []
    act(() => {
      const owner = acquireReviewThreadResolution('subscribed-thread')
      if (owner) {
        acquired.push(owner)
      }
    })
    const owner = acquired[0]
    if (!owner) {
      throw new Error('Unexpected busy key')
    }
    return owner
  }
  let owner = acquire()
  expect(first.result.current).toBe(true)
  expect(unrelated.result.current).toBe(false)
  expect(adoptReviewThreadResolution('wrong-key', owner)).toBe(false)
  expect(adoptReviewThreadResolution('subscribed-thread', owner)).toBe(true)
  expect(adoptReviewThreadResolution('subscribed-thread', owner)).toBe(false)
  act(() => releaseReviewThreadResolution(owner))
  expect(first.result.current).toBe(false)
  owner = acquire()
  expect(first.result.current).toBe(true)
  act(() => releaseReviewThreadResolution(owner))
  expect(first.result.current).toBe(false)
})
