// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const report = vi.hoisted(() => vi.fn())
vi.mock('@/lib/worker-terminal-takeover-report', () => ({
  reportStructuredSessionTouch: report
}))
vi.mock('@/lib/window-park-visibility', () => ({
  getWindowParkVisible: () => true,
  subscribeWindowParkVisibility: () => () => {}
}))
import { useStructuredSessionTouchReport } from './use-structured-session-touch-report'

afterEach(() => {
  cleanup()
  report.mockReset()
})

it('reports when a read chat comes on screen, working or not, and on each turn edge on screen', () => {
  const target = { kind: 'environment', environmentId: 'env-1' } as const
  const { rerender } = renderHook(
    ({ onScreen, readable, working }) =>
      useStructuredSessionTouchReport('s1', target, onScreen, readable, working),
    { initialProps: { onScreen: false, readable: true, working: true } }
  )
  expect(report).not.toHaveBeenCalled()

  // Opening a chat whose worker already reported done, while a later turn still runs.
  rerender({ onScreen: true, readable: true, working: true })
  rerender({ onScreen: true, readable: true, working: true })
  expect(report).toHaveBeenCalledTimes(1)

  rerender({ onScreen: true, readable: true, working: false })
  expect(report).toHaveBeenCalledTimes(2)

  // Hidden or mid re-read, nothing is seen.
  rerender({ onScreen: false, readable: true, working: true })
  rerender({ onScreen: false, readable: true, working: false })
  rerender({ onScreen: true, readable: false, working: false })
  expect(report).toHaveBeenCalledTimes(2)

  rerender({ onScreen: true, readable: true, working: false })
  expect(report).toHaveBeenCalledTimes(3)
  expect(report).toHaveBeenLastCalledWith('s1', 'env-1')
})
