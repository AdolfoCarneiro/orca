import { isWorkerTouchRecorded } from '../../../src/shared/worker-touch-receipt'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileSessionTab } from './mobile-session-route-types'

export type MobileWorkerTouchSubject = { terminal: string } | { sessionId: string }

export function workerTouchSubjectOf(tab: MobileSessionTab): MobileWorkerTouchSubject | null {
  if (tab.type === 'agent-session') {
    return { sessionId: tab.sessionId }
  }
  return tab.type === 'terminal' && typeof tab.terminal === 'string'
    ? { terminal: tab.terminal }
    : null
}

/** The user saw this terminal or chat; true once its host has recorded the keep. */
export function reportMobileWorkerTouch(
  client: Pick<RpcClient, 'sendRequest'>,
  subject: MobileWorkerTouchSubject
): Promise<boolean> {
  return client
    .sendRequest('orchestration.workerChatTouch', subject, {
      timeoutMs: 5_000,
      budgetSpansConnect: true
    })
    .then((response) => response.ok && isWorkerTouchRecorded(response.result))
    .catch(() => false)
}
