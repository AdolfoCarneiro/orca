import { useEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import type { PtyTransport } from './pty-transport-types'

/**
 * A pane that met its WSL host stopped gave up; Start revives it, but so must the host coming back
 * on its own (started elsewhere), or the pane stays dead under a stale error once the card goes.
 */
export function useRetryPanesWhenWslHostReturns(
  ownerEnvironmentId: string | null,
  paneTransports: { readonly current: ReadonlyMap<number, PtyTransport> }
): void {
  const status = useAppStore((state) =>
    ownerEnvironmentId ? state.wslHostStatuses[ownerEnvironmentId]?.state : undefined
  )
  const stoppedHost = useRef<string | null>(null)
  useEffect(() => {
    if (status === 'distro-stopped') {
      stoppedHost.current = ownerEnvironmentId
      return
    }
    if (status !== 'ready' || !ownerEnvironmentId || stoppedHost.current !== ownerEnvironmentId) {
      return
    }
    stoppedHost.current = null
    for (const transport of paneTransports.current.values()) {
      // Why only the host's panes: one on another server never met this stop.
      if (transport.getRuntimeEnvironmentId?.() === ownerEnvironmentId) {
        transport.retryRecovery?.()
      }
    }
  }, [status, ownerEnvironmentId, paneTransports])
}
