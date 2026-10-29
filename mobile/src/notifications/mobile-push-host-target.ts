import { AppState } from 'react-native'
import type { RpcOperationSender } from '../transport/rpc-operation-sender'
import type { MobilePushOwner } from './mobile-push-token-owner'
import { mobilePushRouteKey } from './push-route-declaration'
import type { RouteKeyPreparation } from './push-route-declaration-build'
import {
  loadNotificationDeliveryPreferences,
  notificationPreferencesFilter
} from './notification-delivery-preferences'
import { sendRegister } from './mobile-push-registration-operations'

export type HostPushState = {
  connection: { client: RpcOperationSender | null }
  // An unanswered probe is unknown, not unsupported.
  supported: boolean | null
  routeKeySupported?: boolean
  capabilityProbeStop: (() => void) | null
  chain: Promise<void>
  preparation?: RouteKeyPreparation & { releaseIfObsolete(): void }
  running?: boolean
  dirty?: boolean
  target?: {
    root: MobilePushOwner | undefined
    client: RpcOperationSender
    target: string
    acknowledged: boolean
  }
}

export async function registerMobilePushTarget(
  root: MobilePushOwner,
  state: HostPushState,
  client: RpcOperationSender,
  generation: number,
  isCurrent: () => boolean
): Promise<true | 'stale' | undefined> {
  root.enabled = true
  const renewal = root.renewal
  const capable = state.routeKeySupported
  const token = await root.currentToken()
  let released = false
  const valid = () =>
    !released &&
    root.isCurrent() &&
    isCurrent() &&
    root.intent === generation &&
    root.enabled === true &&
    root.renewal === renewal &&
    state.supported === true &&
    capable === state.routeKeySupported &&
    AppState.currentState === 'active' &&
    JSON.stringify(root.token) === JSON.stringify(token)
  if (!token || !valid()) {
    return
  }
  const filter = notificationPreferencesFilter(await loadNotificationDeliveryPreferences())
  if (!valid()) {
    return
  }
  let routeKey: string | undefined
  if (capable) {
    const handle = mobilePushRouteKey(valid)
    const preparation = {
      ...handle,
      releaseIfObsolete() {
        if (!valid()) {
          released = true
          handle.release()
        }
      }
    }
    state.preparation = preparation
    try {
      const result = await handle.result
      if (result.status === 'retired') {
        return
      }
      routeKey = result.status === 'ready' ? result.routeKey : undefined
    } finally {
      handle.release()
      if (state.preparation === preparation) {
        state.preparation = undefined
      }
    }
  }
  if (!valid() || capable !== state.routeKeySupported) {
    return
  }
  const params = { ...token, filter, ...(routeKey ? { routeKey } : {}) }
  const target = JSON.stringify([generation, root.renewal, true, params, capable])
  const acknowledged = state.target
  if (
    acknowledged?.root === root &&
    acknowledged.client === client &&
    acknowledged.target === target
  ) {
    return
  }
  const attempt = { root, client, target, acknowledged: false }
  state.target = attempt
  const observation = await sendRegister(client, params)
  if (observation.status !== 'registered' || !isCurrent()) {
    return
  }
  if (!valid()) {
    return 'stale'
  }
  attempt.acknowledged = true
  if (routeKey) {
    root.publication.registered(observation.gatewayOrigin)
  }
  return true
}
