import type { AppState } from '@/store/types'
import type { AgentSubjectRead } from '@/attention/agent-subject-read-actions'
import { runtimeTargetForWorkspaceOwner } from '@/lib/resolve-owner'
import { collectLeafIdsInOrder } from '@/components/terminal-pane/terminal-layout-leaf-ids'
import type { WorkerTouch } from '@/lib/worker-terminal-takeover-report'
import { isTerminalLeafId, makePaneKey } from '../../../shared/stable-pane-id'
import type { AutoAckTabTarget } from './agent-auto-ack-targets'
import { isWorkerTouchRecorded } from '../../../shared/worker-touch-receipt'

/** Every split pane of an on-screen terminal tab, and each on-screen chat its view can name. */
export function resolveOnScreenWorkerTouches(
  s: AppState,
  targets: readonly AutoAckTabTarget[],
  reads: readonly AgentSubjectRead[]
): WorkerTouch[] {
  const touches: WorkerTouch[] = []
  for (const read of reads) {
    if (read.structured) {
      touches.push({
        subject: { sessionId: read.structured.sessionId },
        target: read.structured.target
      })
    }
  }
  for (const { tabId, worktreeId, surfaceKind } of targets) {
    const route =
      surfaceKind === 'terminal' && worktreeId
        ? runtimeTargetForWorkspaceOwner(s, { workspaceId: worktreeId })
        : null
    if (!route) {
      continue
    }
    const layout = s.terminalLayoutsByTabId[tabId]
    const leafIds = new Set(collectLeafIdsInOrder(layout?.root))
    if (layout?.activeLeafId) {
      leafIds.add(layout.activeLeafId)
    }
    for (const leafId of leafIds) {
      if (isTerminalLeafId(leafId)) {
        touches.push({ subject: { paneKey: makePaneKey(tabId, leafId) }, target: route })
      }
    }
  }
  return touches
}

/** Reports each target once per stay on screen; a failed or not-yet-recorded report retries on the next scan. */
export function createOnScreenWorkerTouchReporter(
  report: (touch: WorkerTouch) => Promise<unknown>
): {
  hasUnreported: (touches: readonly WorkerTouch[]) => boolean
  report: (touches: readonly WorkerTouch[]) => void
} {
  const reported = new Set<string>()
  const keyOf = (touch: WorkerTouch): string => JSON.stringify([touch.target, touch.subject])
  return {
    hasUnreported: (touches) => touches.some((touch) => !reported.has(keyOf(touch))),
    report: (touches) => {
      const onScreen = new Set(touches.map(keyOf))
      for (const key of reported) {
        if (!onScreen.has(key)) {
          reported.delete(key)
        }
      }
      for (const touch of touches) {
        const key = keyOf(touch)
        if (!reported.has(key)) {
          reported.add(key)
          report(touch).then(
            (result) => {
              if (!isWorkerTouchRecorded(result)) {
                reported.delete(key)
              }
            },
            () => reported.delete(key)
          )
        }
      }
    }
  }
}
