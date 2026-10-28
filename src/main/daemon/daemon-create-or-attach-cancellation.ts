import type { DaemonRequest } from './types'
import type { DaemonRequestRouterOptions } from './daemon-request-router'
export async function cancelDaemonCreateOrAttach(
  options: DaemonRequestRouterOptions,
  clientId: string,
  request: Extract<DaemonRequest, { type: 'cancelCreateOrAttach' }>
): Promise<unknown> {
  const client = options.connections.get(clientId)
  if (request.payload.release) {
    const release = request.payload.release
    if (
      request.payload.settlement ||
      !client?.authenticatedPairEstablished ||
      !client.streamSocket ||
      !release ||
      typeof release.anchor !== 'string' ||
      typeof release.invocationId !== 'string' ||
      (release.outcome !== 'exited' &&
        release.outcome !== 'adopted' &&
        release.outcome !== 'failed') ||
      typeof request.payload.requestId !== 'string' ||
      typeof request.payload.sessionId !== 'string' ||
      (release.incarnationId !== undefined && typeof release.incarnationId !== 'string') ||
      !release.endpoint ||
      typeof release.endpoint.pid !== 'number' ||
      typeof release.endpoint.startedAtMs !== 'number' ||
      typeof release.endpoint.launchNonce !== 'string' ||
      !options.connections.matchesEndpoint(release.endpoint)
    ) {
      return { canceled: false, released: false }
    }
    const released = options.preparations.release(
      request.payload.sessionId,
      clientId,
      request.payload.requestId,
      release
    )
    options.lifecycle.reevaluateIdleShutdown()
    return { canceled: false, released }
  }
  if (request.payload.settlement) {
    if (
      !client?.authenticatedPairEstablished ||
      !client.streamSocket ||
      !options.connections.matchesEndpoint(request.payload.settlement.endpoint)
    ) {
      return { canceled: false, settlement: { outcome: 'unknown' } }
    }
    return {
      canceled: true,
      retention: 'creation-settlement-v1',
      settlement: await options.preparations.settle(
        request.payload.sessionId,
        clientId,
        request.payload.requestId,
        request.payload.settlement,
        (result, code) => {
          const sessionId = result.agentSessionEnsure?.owner.ptyId ?? request.payload.sessionId
          options.streamDataBatcher.enqueueControlEvent(clientId, sessionId, {
            type: 'event',
            event: 'exit',
            sessionId,
            payload: {
              code,
              ...(result.incarnationId ? { incarnationId: result.incarnationId } : {})
            }
          })
          options.streamDataBatcher.flush(clientId)
        }
      )
    }
  }
  return {
    canceled: options.preparations.cancel(request.payload.sessionId, {
      clientId,
      ...(typeof request.payload.requestId === 'string'
        ? { requestId: request.payload.requestId }
        : {})
    })
  }
}
