import { useEffect, useSyncExternalStore } from 'react'
import { getWindowParkVisible, subscribeWindowParkVisibility } from '@/lib/window-park-visibility'
import { reportStructuredSessionTouch } from '@/lib/worker-terminal-takeover-report'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

/** Report when the user sees this chat: it comes on screen read, or its turn starts or ends on screen.
 *  Opening a working chat counts, since its worker may already have reported done.
 *  A reconnect re-reads the chat, so a report lost to a dropped connection is sent again.
 *  The owning host keeps a finished worker's chat on such a report instead of closing it. */
export function useStructuredSessionTouchReport(
  sessionId: string,
  target: RuntimeClientTarget,
  onScreen: boolean,
  readable: boolean,
  working: boolean
): void {
  const windowVisible = useSyncExternalStore(
    subscribeWindowParkVisibility,
    getWindowParkVisible,
    getWindowParkVisible
  )
  const seen = onScreen && windowVisible && readable
  const environmentId = target.kind === 'local' ? null : target.environmentId
  useEffect(() => {
    if (seen) {
      reportStructuredSessionTouch(sessionId, environmentId)
    }
  }, [seen, working, sessionId, environmentId])
}
