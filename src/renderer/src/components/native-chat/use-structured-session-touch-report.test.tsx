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

it('reports when the chat comes on screen at rest and when its turn ends on screen', () => {
  const target = { kind: 'environment', environmentId: 'env-1' } as const
  const { rerender } = renderHook(
    ({ onScreen, isWorking }) => useStructuredSessionTouchReport('s1', target, onScreen, isWorking),
    { initialProps: { onScreen: false, isWorking: false } }
  )
  expect(report).not.toHaveBeenCalled()

  rerender({ onScreen: true, isWorking: false })
  rerender({ onScreen: true, isWorking: false })
  expect(report).toHaveBeenCalledTimes(1)

  rerender({ onScreen: true, isWorking: true })
  rerender({ onScreen: false, isWorking: false })
  expect(report).toHaveBeenCalledTimes(1)

  rerender({ onScreen: true, isWorking: true })
  rerender({ onScreen: true, isWorking: false })
  expect(report).toHaveBeenCalledTimes(2)
  expect(report).toHaveBeenLastCalledWith('s1', 'env-1')
})
