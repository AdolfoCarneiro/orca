import {
  addFanoutListener,
  addFanoutListeners,
  type FanoutEventSource
} from '../event-listener-fanout'

export type RendererLifetimeSender = FanoutEventSource & {
  readonly mainFrame?: { readonly processId: number; readonly routingId: number }
}

export const RENDERER_GONE_MESSAGE = 'The window that started this upload went away'

// Abort only committed document replacement; blocked external links and same-document navigation preserve the caller.
const RENDERER_GONE_EVENTS = ['destroyed', 'render-process-gone', 'did-navigate'] as const

function readPrimaryFrame(sender: RendererLifetimeSender) {
  try {
    const frame = sender.mainFrame
    return frame ? { processId: frame.processId, routingId: frame.routingId } : null
  } catch {
    return null
  }
}

/** Bind main-process work to its requesting renderer; dispose in finally to release WebContents listeners. */
export function abortWhenRendererGone(sender: RendererLifetimeSender): {
  signal: AbortSignal
  dispose: () => void
} {
  const controller = new AbortController()
  const initialFrame = readPrimaryFrame(sender)
  const releases: (() => void)[] = []
  const dispose = (): void => {
    for (const release of releases) {
      release()
    }
  }
  // Shared fan-out: concurrent lifetimes on one renderer add one native listener per event, not one each.
  const abort = (): void => {
    dispose()
    controller.abort(new Error(RENDERER_GONE_MESSAGE))
  }
  releases.push(addFanoutListeners(sender, RENDERER_GONE_EVENTS, abort))
  if (initialFrame) {
    releases.push(
      addFanoutListener(
        sender,
        'did-fail-load',
        (_event, _code, _description, _url, isMainFrame) => {
          if (!isMainFrame) {
            return
          }
          // Error pages skip did-navigate; failed provisional loads can preserve the owner.
          const current = readPrimaryFrame(sender)
          if (
            current &&
            (current.processId !== initialFrame.processId ||
              current.routingId !== initialFrame.routingId)
          ) {
            abort()
          }
        }
      )
    )
  }
  return { signal: controller.signal, dispose }
}
