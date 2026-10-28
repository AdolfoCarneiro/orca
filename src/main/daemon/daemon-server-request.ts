import type { Socket } from 'node:net'
import type { DaemonEndpointLifecycle } from './daemon-endpoint-lifecycle'
import type { DaemonRequestRouter } from './daemon-request-router'
import type { DaemonServerLifecycle } from './daemon-server-lifecycle'
import type { DaemonAutomaticWorkGuard } from './daemon-automatic-work-guard'
import { answerAutomaticWorkRequest } from './daemon-automatic-work-protocol'
import { NOTIFY_PREFIX, type DaemonRequest } from './types'
import { encodeNdjson } from './ndjson'
export async function handleDaemonRequest(
  options: {
    automaticWork: DaemonAutomaticWorkGuard
    endpoint: DaemonEndpointLifecycle
    requestRouter: DaemonRequestRouter
    lifecycle: DaemonServerLifecycle
  },
  socket: Socket,
  clientId: string,
  request: DaemonRequest
): Promise<void> {
  const isNotify = request.id.startsWith(NOTIFY_PREFIX)
  try {
    const result =
      answerAutomaticWorkRequest(request, options.automaticWork, options.endpoint) ??
      (await options.requestRouter.route(clientId, request))
    if (!isNotify) {
      socket.write(encodeNdjson({ id: request.id, ok: true, payload: result }), () => {
        options.lifecycle.startPendingShutdownReply(clientId, request.id)
      })
    }
  } catch (error) {
    if (!isNotify) {
      socket.write(
        encodeNdjson({
          id: request.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        })
      )
    }
  }
}
