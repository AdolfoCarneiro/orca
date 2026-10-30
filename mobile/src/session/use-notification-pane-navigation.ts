import { useEffect, useRef, useState } from 'react'
import { usePageBridgeClient } from '../transport/client-context.web'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileSessionTab } from './mobile-session-route-types'
import { notificationPaneTab } from './notification-pane-tab'
import { mobileSenderOpenFailure } from './mobile-agent-message-open-outcome'

// A clear-by-value acknowledges receipt; inventory can still arrive after that acknowledgment.
export function useNotificationPaneNavigation({
  sessionTabs,
  terminalsLoaded,
  switchSessionTab,
  client: authority,
  worktreeId,
  showToast
}: {
  sessionTabs: MobileSessionTab[]
  terminalsLoaded: boolean
  switchSessionTab: (tab: MobileSessionTab) => Promise<boolean> | undefined
  client: RpcClient | null
  worktreeId: string
  showToast: (message: string, duration?: number) => void
}) {
  const bridge = usePageBridgeClient()
  const [asked, setAsked] = useState(0)
  const pending = useRef<{
    paneKey: string
    generation?: number
    selecting: boolean
    timer: ReturnType<typeof setTimeout>
  } | null>(null)
  const latest = useRef({ switchSessionTab, showToast })
  latest.current = { switchSessionTab, showToast }
  useEffect(() => {
    let active = true
    const pathname = bridge.getShellSession()?.route?.pathname
    let seen: { paneKey: string; generation: number | undefined } | null = null
    const cancel = () => {
      if (pending.current) {
        clearTimeout(pending.current.timer)
      }
      pending.current = null
    }
    const receive = (paneKey: string) => {
      const generation = authority?.getGeneration?.()
      if (pending.current && pending.current.generation !== generation) {
        cancel()
      }
      if (seen?.generation !== generation) {
        seen = null
      }
      if (!paneKey) {
        seen = null
        return
      }
      const duplicate = seen?.paneKey === paneKey || pending.current?.paneKey === paneKey
      seen = { paneKey, generation }
      bridge.clearRouteParam('paneKey', paneKey)
      if (duplicate) {
        return
      }
      cancel()
      const request = {
        paneKey,
        generation,
        selecting: false,
        timer: setTimeout(() => {
          if (!active || pending.current !== request) {
            return
          }
          pending.current = null
          if (authority?.getGeneration?.() === request.generation) {
            latest.current.showToast(mobileSenderOpenFailure('unreachable'), 3000)
          }
        }, 5000)
      }
      pending.current = request
      setAsked((value) => value + 1)
    }
    receive(bridge.getShellSession()?.route?.params?.paneKey ?? '')
    const unsubscribe = bridge.onRouteUpdate((route) => {
      // An update for a replacement route cannot leave this visit's intent alive.
      if (!route || (pathname && route.pathname !== pathname)) {
        seen = null
        cancel()
        return
      }
      receive(route?.params?.paneKey ?? '')
    })
    return () => {
      active = false
      cancel()
      unsubscribe()
    }
  }, [bridge, authority, worktreeId])

  useEffect(() => {
    const request = pending.current
    if (!request || request.selecting || !terminalsLoaded) {
      return
    }
    if (authority?.getGeneration?.() !== request.generation) {
      clearTimeout(request.timer)
      pending.current = null
      return
    }
    const tab = notificationPaneTab(sessionTabs, request.paneKey)
    if (!tab) {
      return
    }
    request.selecting = true
    let opening: Promise<boolean> | undefined
    try {
      opening = latest.current.switchSessionTab(tab)
    } catch (error) {
      opening = Promise.reject(error)
    }
    void Promise.resolve(opening).then(
      (opened) => {
        if (pending.current !== request) {
          return
        }
        clearTimeout(request.timer)
        pending.current = null
        if (opened === false && authority?.getGeneration?.() === request.generation) {
          latest.current.showToast(mobileSenderOpenFailure('unreachable'), 3000)
        }
      },
      () => {
        if (pending.current !== request) {
          return
        }
        clearTimeout(request.timer)
        pending.current = null
        if (authority?.getGeneration?.() === request.generation) {
          latest.current.showToast(mobileSenderOpenFailure('unreachable'), 3000)
        }
      }
    )
  }, [asked, sessionTabs, terminalsLoaded, authority])
}
