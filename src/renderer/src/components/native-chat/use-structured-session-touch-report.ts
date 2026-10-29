import { useEffect, useSyncExternalStore } from 'react'
import { getWindowParkVisible, subscribeWindowParkVisibility } from '@/lib/window-park-visibility'
import { reportStructuredSessionTouch } from '@/lib/worker-terminal-takeover-report'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

/** Report when the user sees this chat at rest: it comes on screen idle, or its turn ends on screen.
 *  The owning host keeps a finished worker's chat on such a report instead of closing it. */
export function useStructuredSessionTouchReport(
  sessionId: string,
  target: RuntimeClientTarget,
  onScreen: boolean,
  isWorking: boolean
): void {
  const windowVisible = useSyncExternalStore(
    subscribeWindowParkVisibility,
    getWindowParkVisible,
    getWindowParkVisible
  )
  const seenAtRest = onScreen && windowVisible && !isWorking
  const environmentId = target.kind === 'local' ? null : target.environmentId
  useEffect(() => {
    if (seenAtRest) {
      reportStructuredSessionTouch(sessionId, environmentId)
    }
  }, [seenAtRest, sessionId, environmentId])
}
