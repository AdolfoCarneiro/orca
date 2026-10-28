import type { RpcContext } from '../core'
import { recordWorkspace } from './structured-agent-session-switch-source'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
export async function retainStructuredSwitchSource(
  runtime: RpcContext['runtime'],
  host: StructuredAgentSessionHost,
  sessionId: string,
  invocationId: string,
  check: () => void
): Promise<void> {
  if (!host.deps.store.getRecord(sessionId)) {
    return
  }
  check()
  const revealed = await host.revealSession(sessionId)
  check()
  await runtime.publishStructuredAgentSessionTab({
    ...revealed,
    activate: false,
    check
  })
  runtime.retainSessionSwitchProjection(
    recordWorkspace(host, sessionId),
    sessionId,
    invocationId,
    host.switchGeneration(sessionId) ?? invocationId
  )
}
