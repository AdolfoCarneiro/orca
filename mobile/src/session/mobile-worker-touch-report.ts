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

/** The user saw this terminal or chat; its host keeps it if it is a worker. */
export function reportMobileWorkerTouch(
  client: Pick<RpcClient, 'sendRequest'>,
  subject: MobileWorkerTouchSubject
): void {
  void client
    .sendRequest('orchestration.workerChatTouch', subject, {
      timeoutMs: 5_000,
      budgetSpansConnect: true
    })
    .catch(() => {})
}
