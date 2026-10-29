import { mobilePushRouteKey, publishPushRoutes } from './push-route-declaration'
import type {
  MobilePushFilter,
  MobilePushRegisterInput
} from '../../../src/shared/mobile-push-contract'
import type { RpcOperationSender } from '../transport/rpc-operation-sender'
import type { MobilePushToken } from './push-token'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import {
  notificationUnreadReplySchema,
  pushRouteRegistrationSchema
} from './notification-reply-schema'

// Skip reconciliation refusals under catch(() => null): preserve stored route state until retry, with no screen requiring a host error.

export const pushRouteRegister = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'notifications.register-push-or-skip',
    method: 'notifications.registerPush',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('push-registration', pushRouteRegistrationSchema)
  })
)

export const pushRouteUnregister = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'notifications.unregister-push-or-skip',
    method: 'notifications.unregisterPush',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('push-unregistered', notificationUnreadReplySchema)
  })
)

export async function sendRegister(
  client: RpcOperationSender,
  token: MobilePushToken,
  filter: MobilePushFilter,
  routeKeySupported = false
): Promise<boolean> {
  const params: Omit<MobilePushRegisterInput, 'deviceId'> = {
    ...(routeKeySupported ? { routeKey: await mobilePushRouteKey() } : {}),
    platform: token.platform,
    token: token.token,
    ...(token.apnsEnvironment ? { apnsEnvironment: token.apnsEnvironment } : {}),
    filter
  }
  const reply = await pushRouteRegister
    .request(client, params, { timeoutMs: 5000, failWhenDisconnected: true })
    .catch(() => null)
  const registration = reply && pushRouteRegister.interpret(reply)
  if (!registration?.accepted) {
    return false
  }
  if (registration.value?.registered === true) {
    publishPushRoutes(token, registration.value.gatewayOrigin)
  }
  return registration.value?.registered === true
}
