import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { reportWorkerTakeoverOncePerWindow } from '../../../shared/worker-terminal-takeover-report-gate'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'

const lastReportByPaneKey = new Map<string, number>()

/** Only real user input signals durable takeover on the terminal owner; exclude replies, prompt delivery, resize and output. */
export function reportWorkerTerminalUserInput(
  paneKey: string,
  runtimeEnvironmentId: string | null
): void {
  reportTakeover({ paneKey }, runtimeEnvironmentId)
}

/** Address structured workers by session, never secret pane key. The owning runtime resolves its credential; exposing it to renderer would let chat observers learn it. */
export function reportStructuredSessionUserInput(
  sessionId: string,
  runtimeEnvironmentId: string | null
): void {
  reportTakeover({ sessionId }, runtimeEnvironmentId)
}

export type WorkerTouch = {
  subject: { paneKey: string } | { sessionId: string }
  target: RuntimeClientTarget
}

/** The user saw this terminal or chat; its owning host keeps it if it is a worker. */
export function reportWorkerTouch({ subject, target }: WorkerTouch): Promise<unknown> {
  return callRuntimeRpc(target, 'orchestration.workerChatTouch', subject, {
    suppressFeatureInteraction: true,
    reuseRecentCompatibilityFailure: true
  })
}

function runtimeTarget(runtimeEnvironmentId: string | null): RuntimeClientTarget {
  return runtimeEnvironmentId !== null
    ? { kind: 'environment', environmentId: runtimeEnvironmentId }
    : { kind: 'local' }
}

function reportTakeover(
  subject: { paneKey: string } | { sessionId: string },
  runtimeEnvironmentId: string | null
): void {
  // Gate per runtime too, so a pane rebound to another owner reports there.
  reportWorkerTakeoverOncePerWindow(
    lastReportByPaneKey,
    JSON.stringify([runtimeEnvironmentId, subject]),
    () =>
      callRuntimeRpc(
        runtimeTarget(runtimeEnvironmentId),
        'orchestration.workerTerminalUserInput',
        subject,
        { suppressFeatureInteraction: true, reuseRecentCompatibilityFailure: true }
      )
  )
}
