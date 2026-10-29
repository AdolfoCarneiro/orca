import { deriveRelayHostId } from '../mobile-cloud-relay/relay-http-client'
import { join } from 'node:path'
import { DeviceRegistry } from '../device-registry'
import { RuntimeMobileNotificationController } from '../runtime-mobile-notification-controller'
import { PushUnregisterOutbox } from './push-unregister-outbox'
import { DesktopPushService } from './desktop-push-service'
import { PushGatewayClient } from './push-gateway-client'
import { createPushHostKeypair } from './push-host-challenge-fixtures'
import { NotificationRegisterPushParams } from '../../../shared/rpc-contract/notifications-params'
import { record, text } from '../../../shared/push-owner-integration.test-fixture'

export function desktopActors(
  path: string,
  transport: (host: string, url: string, init?: RequestInit) => Promise<Response>
) {
  const actors = ['A', 'B'].map((id) => {
    const registry = new DeviceRegistry(join(path, id))
    const device = registry.addDevice('synthetic integration phone', 'mobile')
    const controller = new RuntimeMobileNotificationController()
    const keypair = createPushHostKeypair()
    const outbox = new PushUnregisterOutbox(join(path, id))
    const client = new PushGatewayClient({
      gatewayUrl: 'https://push.onorca.dev',
      keypair,
      fetch: (url, init) => transport(id, String(url), init)
    })
    const service = DesktopPushService.create({
      runtime: {
        setMobilePushOrigin: controller.setPushOrigin.bind(controller),
        setMobilePushRegistrar: controller.setPushRegistrar.bind(controller),
        onNotificationDispatched: controller.onDispatched.bind(controller)
      },
      runtimeRpc: {
        getE2EEKeypair: () => keypair,
        getDeviceRegistry: () => registry,
        getPushUnregisterOutbox: () => outbox,
        setOnPushUnregisterQueued: () => {}
      },
      gatewayUrl: 'https://push.onorca.dev',
      client
    })
    if (!service) {
      throw new Error('Actual desktop service did not start')
    }
    service.start()
    return { id, registry, device, controller, service, keypair }
  })
  const source = actors.find((actor) => actor.id === 'B')
  if (!source) {
    throw new Error('Missing actual origin actor')
  }
  const origin = deriveRelayHostId(source.keypair.publicKey)
  return {
    origin,
    profiles: actors.map((actor) => ({
      id: actor.id,
      name: actor.id,
      endpoint: 'ws://127.0.0.1:1',
      lastConnected: 0,
      publicKeyB64: actor.keypair.publicKeyB64
    })),
    async rpc(value: Record<string, unknown>) {
      const host = text(value.host)
      const actor = actors.find((candidate) => candidate.id === host)
      if (!actor) {
        throw new Error('Unknown paired fixture host')
      }
      const method = text(value.method)
      if (method === 'status.get') {
        return { capabilities: ['notifications.remote-push.v1', 'notifications.push-route-key.v1'] }
      }
      if (method === 'notifications.registerPush') {
        const params = NotificationRegisterPushParams.parse(value.params)
        return actor.controller.registerPushDevice({ ...params, deviceId: actor.device.deviceId })
      }
      if (method === 'notifications.unregisterPush') {
        return actor.controller.unregisterPushDevice(actor.device.deviceId)
      }
      throw new Error(`Unexpected actual mobile method ${method}`)
    },
    dispatch(occurrence: string) {
      for (const actor of actors) {
        actor.controller.dispatch({
          type: 'notification',
          source: 'agent-task-complete',
          agentState: 'done',
          origin,
          occurrence,
          notificationId: `same-decision-${occurrence}`,
          title: 'Complete',
          body: 'Ready',
          desktopAway: true
        })
      }
    },
    registered() {
      return actors.map((actor) =>
        record(actor.registry.getDevice(actor.device.deviceId)?.pushRegistration)
      )
    },
    stop() {
      for (const actor of actors) {
        actor.service.stop()
      }
    }
  }
}
