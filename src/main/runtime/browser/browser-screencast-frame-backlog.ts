import type {
  ActiveBrowserScreencastPage,
  ActiveBrowserScreencastSubscriber
} from './browser-screencast-contracts'

export function createScreencastFrameBacklogObserver(
  active: ActiveBrowserScreencastPage,
  subscriptionId: string
): NonNullable<ActiveBrowserScreencastSubscriber['onFrameSend']> {
  return (bytes, outcome) => {
    if (
      outcome === 'backlogged' ||
      active.stopping ||
      !active.subscribers.has(subscriptionId) ||
      active.backloggedFrame !== bytes
    ) {
      return
    }
    active.backloggedFrame = null
    active.frameDeliveryGeneration += 1
    if (active.session) {
      active.session.requestFrame?.()
    } else {
      active.pendingFrameRefresh = true
    }
  }
}
