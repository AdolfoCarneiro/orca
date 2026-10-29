// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => {
  const wslHostStatuses: Record<string, { state: string }> = {}
  return { wslHostStatuses }
})

vi.mock('@/store', () => ({
  useAppStore: <T>(selector: (state: typeof store) => T) => selector(store)
}))

import type { PtyTransport } from './pty-transport-types'
import { useRetryPanesWhenWslHostReturns } from './use-wsl-host-return-retry'

function pane(environmentId: string | null): PtyTransport {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook reads only these two members.
  return {
    getRuntimeEnvironmentId: () => environmentId,
    retryRecovery: vi.fn(() => true)
  } as unknown as PtyTransport
}

function hostStatus(state: string): void {
  store.wslHostStatuses = { 'wsl:ubuntu': { state } }
}

afterEach(() => {
  cleanup()
  store.wslHostStatuses = {}
})

describe('a stopped WSL host coming back on its own', () => {
  it("retries the host's panes once it is ready again, and only those", () => {
    hostStatus('ready')
    const hostPane = pane('wsl:ubuntu')
    const otherPane = pane('ssh:desk')
    const transports = {
      current: new Map([
        [1, hostPane],
        [2, otherPane]
      ])
    }
    const { rerender } = renderHook(() => useRetryPanesWhenWslHostReturns('wsl:ubuntu', transports))
    expect(hostPane.retryRecovery).not.toHaveBeenCalled()

    for (const state of ['distro-stopped', 'connecting', 'ready']) {
      hostStatus(state)
      rerender()
    }
    expect(hostPane.retryRecovery).toHaveBeenCalledOnce()
    expect(otherPane.retryRecovery).not.toHaveBeenCalled()

    // Ready again with no stop between leaves healthy panes alone.
    hostStatus('connecting')
    rerender()
    hostStatus('ready')
    rerender()
    expect(hostPane.retryRecovery).toHaveBeenCalledOnce()
  })

  it('counts a stop already showing when the pane mounts', () => {
    hostStatus('distro-stopped')
    const hostPane = pane('wsl:ubuntu')
    const { rerender } = renderHook(() =>
      useRetryPanesWhenWslHostReturns('wsl:ubuntu', { current: new Map([[1, hostPane]]) })
    )
    hostStatus('ready')
    rerender()
    expect(hostPane.retryRecovery).toHaveBeenCalledOnce()
  })
})
