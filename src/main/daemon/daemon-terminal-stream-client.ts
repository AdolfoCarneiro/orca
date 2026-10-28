import { performance } from 'node:perf_hooks'
import { recordDaemonStreamBacklogEvent } from './daemon-stream-backlog-probe'
import type { CreateOrAttachOptions } from './terminal-host'
import type { DaemonTerminalAdmissionOptions } from './daemon-terminal-admission'
const INTERACTIVE_OUTPUT_WINDOW_MS = 100
const INTERACTIVE_OUTPUT_MAX_CHARS = 1024
export function createAdmissionStreamClient(
  options: DaemonTerminalAdmissionOptions,
  clientId: string,
  sessionId: () => string
): CreateOrAttachOptions['streamClient'] {
  return {
    onData: (data, rawLength = data.length, transformed = false, seq) => {
      const routedSessionId = sessionId()
      options.transientFactRelay.onSessionData(routedSessionId, data)
      const lastInputAt = options.attachments.lastInputAt(routedSessionId)
      const isInteractiveOutput =
        data.length <= INTERACTIVE_OUTPUT_MAX_CHARS &&
        lastInputAt !== undefined &&
        performance.now() - lastInputAt <= INTERACTIVE_OUTPUT_WINDOW_MS
      options.streamDataBatcher.enqueue(clientId, routedSessionId, data, {
        flushImmediately: isInteractiveOutput,
        flushMaxChars: INTERACTIVE_OUTPUT_MAX_CHARS,
        rawLength,
        transformed,
        seq
      })
    },
    onInputClosed: (incarnationId) => {
      const routedSessionId = sessionId()
      options.streamDataBatcher.enqueueControlEvent(clientId, routedSessionId, {
        type: 'event',
        event: 'inputClosed',
        sessionId: routedSessionId,
        payload: { incarnationId }
      })
      options.streamDataBatcher.flush(clientId)
    },
    onExit: (code, incarnationId, cause) => {
      const routedSessionId = sessionId()
      options.log.log('session-exited', {
        sessionId: routedSessionId,
        code,
        cause: cause?.kind
      })
      options.streamDataBatcher.enqueueControlEvent(clientId, routedSessionId, {
        type: 'event',
        event: 'exit',
        sessionId: routedSessionId,
        payload: { code, incarnationId, ...(cause ? { cause } : {}) }
      })
      options.streamDataBatcher.flush(clientId)
      recordDaemonStreamBacklogEvent('sessionExit', {
        sessionIdSuffix: routedSessionId.slice(-10)
      })
      options.transientFactRelay.onSessionExit(routedSessionId)
      options.streamDataBatcher.refreshSessionDroppability(routedSessionId)
      options.attachments.release(routedSessionId)
      options.reevaluateIdleShutdown()
    }
  }
}
