import { AppState } from 'react-native'
import { loadPushNotificationsEnabled } from '../storage/preferences'
import { ensureDesktopNotificationChannel } from './desktop-notification-channel'
import { startMobilePushLeaseRenewal } from './mobile-push-lease-renewal'
import { addPushTokenListener, getDevicePushToken, type MobilePushToken } from './push-token'
import { startPushRoutePublication } from './push-route-declaration'

export type MobilePushOwner = ReturnType<typeof createMobilePushOwner>

export function createMobilePushOwner(
  current: () => boolean,
  generation: () => number,
  changed: () => void
) {
  let active = true
  let stopLease = () => {}
  let stopToken = () => {}
  let observation: object = {}
  let acquisition: Promise<void> | undefined
  let renewalWake = false
  const root: {
    token: MobilePushToken | null
    enabled: boolean | undefined
    intent: number
    renewal: number
    publication: ReturnType<typeof startPushRoutePublication>
    isCurrent: () => boolean
    invalidate: () => void
    rederive: () => void
    refresh: () => void
    currentToken: () => Promise<MobilePushToken | null>
    start: () => void
    stop: () => void
  } = {
    token: null,
    enabled: undefined,
    intent: generation(),
    renewal: 0,
    publication: startPushRoutePublication(() =>
      root.isCurrent() && root.enabled && root.token
        ? { token: root.token, intent: root.intent }
        : undefined
    ),
    isCurrent: () => active && current() && root.intent === generation(),
    invalidate() {
      root.enabled = undefined
      root.publication.wake('input')
    },
    rederive() {
      root.intent = generation()
      void refresh()
    },
    refresh: () => {
      void refresh()
    },
    async currentToken(): Promise<MobilePushToken | null> {
      if (!root.token) {
        let timer: ReturnType<typeof setTimeout> | undefined
        await Promise.race([
          acquisition ?? Promise.resolve(),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 2000)
          })
        ]).finally(() => clearTimeout(timer))
      }
      return root.isCurrent() ? root.token : null
    },
    start() {
      stopLease = startMobilePushLeaseRenewal(async () => {
        if (!root.isCurrent()) {
          return
        }
        root.renewal++
        renewalWake = true
        void refresh()
        changed()
      })
      stopToken = addPushTokenListener((token) => {
        if (!active || !current()) {
          return
        }
        observation = {}
        root.token = token
        void refresh()
      })
      void refresh()
      changed()
    },
    stop() {
      active = false
      root.publication.stop()
      stopLease()
      stopToken()
    }
  }
  function project(): void {
    if (!root.isCurrent()) {
      return
    }
    root.publication.wake(renewalWake ? 'renewal' : 'input')
    renewalWake = false
    if (root.token && root.enabled) {
      changed()
    }
  }
  async function refresh(): Promise<void> {
    const observed = observation
    const intent = root.intent
    const valid = () => root.isCurrent() && root.intent === intent && observation === observed
    try {
      const enabled = await loadPushNotificationsEnabled()
      if (!valid()) {
        return
      }
      root.enabled = enabled
      if (enabled && AppState.currentState === 'active' && !root.token && !acquisition) {
        const pending = (async () => {
          await ensureDesktopNotificationChannel()
          if (!valid() || AppState.currentState !== 'active') {
            return
          }
          const token = await getDevicePushToken()
          if (valid()) {
            root.token = token
          }
        })()
          .catch(() => {})
          .finally(() => {
            if (acquisition === pending) {
              acquisition = undefined
            }
            if (!root.isCurrent()) {
              return
            }
            if (root.intent !== intent) {
              void refresh()
            } else if (observation === observed) {
              project()
            }
          })
        acquisition = pending
      }
      project()
    } catch {
      if (valid()) {
        root.enabled = undefined
        project()
      }
    }
  }
  return root
}
