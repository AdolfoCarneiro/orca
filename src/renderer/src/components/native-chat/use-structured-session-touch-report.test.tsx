// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const report = vi.hoisted(() => vi.fn())
vi.mock('@/lib/worker-terminal-takeover-report', () => ({ reportStructuredSessionTouch: report }))
vi.mock('@/lib/window-park-visibility', () => ({
  getWindowParkVisible: () => true,
  subscribeWindowParkVisibility: () => () => {}
}))
import { useStructuredSessionTouchReport } from './use-structured-session-touch-report'

afterEach(() => {
  cleanup()
  report.mockReset()
})

it('reports when the chat comes on screen at rest and each time it comes to rest on screen', () => {
  const target = { kind: 'environment', environmentId: 'env-1' } as const
  const { rerender } = renderHook(
    ({ onScreen, atRest }) => useStructuredSessionTouchReport('s1', target, onScreen, atRest),
    { initialProps: { onScreen: false, atRest: true } }
  )
  expect(report).not.toHaveBeenCalled()

  rerender({ onScreen: true, atRest: true })
  rerender({ onScreen: true, atRest: true })
  expect(report).toHaveBeenCalledTimes(1)

  // A turn or a reconnect re-read takes it out of rest; hidden, coming back to rest says nothing.
  rerender({ onScreen: true, atRest: false })
  rerender({ onScreen: false, atRest: true })
  expect(report).toHaveBeenCalledTimes(1)

  rerender({ onScreen: true, atRest: false })
  rerender({ onScreen: true, atRest: true })
  expect(report).toHaveBeenCalledTimes(2)
  expect(report).toHaveBeenLastCalledWith('s1', 'env-1')
})
