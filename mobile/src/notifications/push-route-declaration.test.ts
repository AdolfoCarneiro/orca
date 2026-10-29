import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import nacl from 'tweetnacl'
import { pushRouteDeclarationContent } from '../../../cloud/packages/push-contract/src/route-declaration-content'
import type { PushRouteDeclaration } from '../../../cloud/packages/push-contract/src/route-declaration'

const state = vi.hoisted(() => ({
  storage: new Map<string, string>(),
  keys: new Map<string, string>(),
  loads: 0,
  token: {
    platform: 'ios' as const,
    token: 'ab'.repeat(32),
    apnsEnvironment: 'production' as const
  }
}))
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => {
      if (key === 'orca:hosts') state.loads++
      return state.storage.get(key) ?? null
    },
    setItem: async (key: string, value: string) => {
      state.storage.set(key, value)
    },
    removeItem: async (key: string) => {
      state.storage.delete(key)
    }
  }
}))
vi.mock('../transport/pairing-keychain', () => ({
  readPairingKeychainItem: async (key: string) => state.keys.get(key) ?? null,
  writePairingKeychainItem: async (key: string, value: string) => {
    state.keys.set(key, value)
  }
}))
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  AppState: { currentState: 'active', addEventListener: vi.fn(() => ({ remove: vi.fn() })) }
}))
vi.mock('./desktop-notification-channel', () => ({
  ensureDesktopNotificationChannel: async () => {}
}))
vi.mock('./push-token', () => ({
  getDevicePushToken: async () => state.token,
  addPushTokenListener: () => () => {}
}))
vi.mock('../transport/host-credential-cleanup', () => ({
  cancelPendingHostCredentialCleanup: async () => {},
  recordHostCredentialCleanupIntent: async () => {},
  scheduleHostCredentialCleanup: async () => {},
  retryPendingHostCredentialCleanups: async () => {}
}))
vi.mock('../transport/mobile-relay-host-overlay-store', () => ({
  removeMobileRelayHostRouting: async () => {}
}))
vi.mock('../mobile-web-shell/removed-host-shell-cache', () => ({
  deleteHostPageCache: async () => {},
  forgetHostUpdateFailures: async () => {}
}))

let publisher: typeof import('./push-route-declaration')
let stop: (() => void) | undefined
const token = state.token
function hosts(count: number): void {
  state.storage.set(
    'orca:hosts',
    JSON.stringify(
      Array.from({ length: count }, (_, i) => ({
        id: `host-${i}`,
        name: `Host ${i}`,
        endpoint: 'ws://127.0.0.1:1',
        lastConnected: 0,
        publicKeyB64: Buffer.alloc(32, i + 1).toString('base64')
      }))
    )
  )
}
beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  state.storage.clear()
  state.keys.clear()
  state.loads = 0
  hosts(1)
  publisher = await import('./push-route-declaration')
  await publisher.mobilePushRouteKey()
})
afterEach(() => {
  stop?.()
  stop = undefined
  publisher.stopPushRoutePublication()
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
const settle = () => vi.advanceTimersByTimeAsync(0)
function requests(status = 200) {
  const bodies: PushRouteDeclaration[] = []
  const send = vi.fn(async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)))
    return new Response('{}', { status })
  })
  vi.stubGlobal('fetch', send)
  return { bodies, send }
}

it('persists signed versions before sending and retries a lost response identically', async () => {
  const { bodies, send } = requests()
  send.mockImplementationOnce(async (_url, init) => {
    bodies.push(JSON.parse(String(init.body)))
    throw new Error('response lost')
  })
  publisher.publishPushRoutes(token, 'https://untrusted.invalid')
  await settle()
  expect(fetch).not.toHaveBeenCalled()
  publisher.publishPushRoutes(token, 'https://push.onorca.dev')
  await settle()
  await vi.advanceTimersByTimeAsync(1000)
  expect(bodies).toHaveLength(2)
  expect(bodies[1]).toEqual(bodies[0])
  expect(Number(state.storage.get('orca:push-route-version'))).toBe(bodies[0].version)
  expect(
    nacl.sign.detached.verify(
      Buffer.from(pushRouteDeclarationContent(bodies[0])),
      Buffer.from(bodies[0].signature, 'base64url'),
      Buffer.from(bodies[0].routeKey, 'base64url')
    )
  ).toBe(true)
  hosts(0)
  publisher.refreshPushRoutes()
  await settle()
  expect(bodies[2].version).toBeGreaterThan(bodies[0].version)
  expect(bodies[2].hosts).toEqual([])
})

it('recovers saved key/version with current token and removes an unreachable host after cold startup', async () => {
  hosts(2)
  const { bodies, send } = requests()
  publisher.publishPushRoutes(token, 'https://push.onorca.dev')
  await settle()
  const prior = bodies[0]
  publisher.stopPushRoutePublication()
  vi.resetModules()
  publisher = await import('./push-route-declaration')
  const registration = await import('./push-registration')
  stop = registration.startPushTokenSync()
  await settle()
  expect(bodies[1].version).toBeGreaterThan(prior.version)
  expect(bodies[1].routeKey).toBe(prior.routeKey)
  const { removeHostAndCloseClient } = await import('../transport/host-removal-lifecycle')
  await removeHostAndCloseClient('host-0', vi.fn())
  await settle()
  expect(bodies.at(-1)?.hosts).toHaveLength(1)
  expect(bodies.at(-1)?.hosts).not.toContain(
    (await import('./push-host-fingerprint')).deriveHostFingerprint(
      Buffer.alloc(32, 1).toString('base64')
    )
  )
  send.mockImplementationOnce(async () => {
    throw new Error('response lost after removal')
  })
  publisher.refreshPushRoutes()
  await settle()
  stop()
  stop = undefined
  vi.resetModules()
  publisher = await import('./push-route-declaration')
  stop = (await import('./push-registration')).startPushTokenSync()
  await settle()
  expect(bodies.at(-1)?.hosts).toHaveLength(1)
  expect(bodies.at(-1)?.version).toBeGreaterThan(prior.version)
})

it('parks deletion-first last-host400 and resumes even unchanged membership after a real registration', async () => {
  const { send } = requests()
  const registration = await import('./push-registration')
  const { sendRegister } = await import('./mobile-push-registration-operations')
  let live = true
  const client = {
    sendRequest: vi.fn(async (method: string) => {
      if (method === 'status.get')
        return {
          id: 'req',
          ok: true as const,
          result: {
            capabilities: [
              registration.NOTIFICATIONS_REMOTE_PUSH_CAPABILITY,
              'notifications.push-route-key.v1'
            ]
          }
        }
      if (method === 'notifications.unregisterPush') {
        live = false
        return { id: 'req', ok: true as const, result: { unregistered: true } }
      }
      live = true
      return {
        id: 'req',
        ok: true as const,
        result: { registered: true, gatewayOrigin: 'https://push.onorca.dev' }
      }
    })
  }
  await registration.setRemotePushEnabled(true)
  registration.attachPushRegistration('host-0', client)
  await settle()
  expect(send).toHaveBeenCalledTimes(1)
  send.mockImplementation(async () => new Response('{}', { status: live ? 200 : 400 }))
  await (
    await import('../transport/host-removal-lifecycle')
  ).removeHostAndCloseClient('host-0', vi.fn())
  expect(
    client.sendRequest.mock.calls.filter(([method]) => method === 'notifications.unregisterPush')
  ).toHaveLength(1)
  await settle()
  await vi.advanceTimersByTimeAsync(1000)
  const parked = send.mock.calls.length
  await vi.advanceTimersByTimeAsync(10 * 60_000)
  expect(send).toHaveBeenCalledTimes(parked)
  await sendRegister(client, token, {}, true)
  await settle()
  expect(send).toHaveBeenCalledTimes(parked + 1)
})

it('preserves a registration wake racing a permanent refusal and retries transient failures', async () => {
  const { send } = requests()
  let release!: (response: Response) => void
  send.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve
      })
  )
  publisher.publishPushRoutes(token, 'https://push.onorca.dev')
  await settle()
  publisher.publishPushRoutes(token, 'https://push.onorca.dev')
  release(new Response('{}', { status: 400 }))
  await settle()
  await vi.advanceTimersByTimeAsync(1)
  expect(send).toHaveBeenCalledTimes(2)
  for (const status of [429, 503, 404]) {
    send.mockImplementation(async () => new Response('{}', { status }))
    publisher.refreshPushRoutes()
    await settle()
    const before = send.mock.calls.length
    await vi.advanceTimersByTimeAsync(1000)
    expect(send).toHaveBeenCalledTimes(before + (status === 404 ? 0 : 1))
  }
  const parked = send.mock.calls.length
  await vi.advanceTimersByTimeAsync(60_000)
  expect(send).toHaveBeenCalledTimes(parked)
  publisher.publishPushRoutes(token, 'https://push.onorca.dev')
  await settle()
  expect(send).toHaveBeenCalledTimes(parked + 1)
})

it.each([4, 40])(
  'does one catalog pass/signature/POST per logical renewal with %s staggered host replies',
  async (count) => {
    hosts(count)
    const { send } = requests()
    const fingerprint = await import('./push-host-fingerprint')
    const hashes = vi.spyOn(fingerprint, 'deriveHostFingerprint')
    const signs = vi.spyOn(nacl.sign, 'detached')
    const { sendRegister } = await import('./mobile-push-registration-operations')
    const client = {
      sendRequest: vi.fn(async () => ({
        id: 'req',
        ok: true as const,
        result: { registered: true, gatewayOrigin: 'https://push.onorca.dev' }
      }))
    }
    state.loads = 0
    for (let i = 0; i < count; i++) {
      await sendRegister(client, token, {}, true)
      await settle()
    }
    expect(state.loads).toBe(1)
    expect(hashes).toHaveBeenCalledTimes(count)
    expect(signs).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledTimes(1)
    const { startPushTokenSync } = await import('./push-registration')
    stop = startPushTokenSync()
    await settle()
    const baseline = {
      loads: state.loads,
      hashes: hashes.mock.calls.length,
      signs: signs.mock.calls.length,
      sends: send.mock.calls.length
    }
    await vi.advanceTimersByTimeAsync(15 * 60_000)
    for (let i = 0; i < count; i++) {
      await sendRegister(client, token, {}, true)
      await settle()
    }
    expect(state.loads - baseline.loads).toBe(1)
    expect(hashes.mock.calls.length - baseline.hashes).toBe(count)
    expect(signs.mock.calls.length - baseline.signs).toBe(1)
    expect(send.mock.calls.length - baseline.sends).toBe(1)
  }
)

it('withdraws the prior100 declaration for the exact102 then removed→101 catalog without truncation', async () => {
  hosts(100)
  const { bodies } = requests()
  publisher.publishPushRoutes(token, 'https://push.onorca.dev')
  await settle()
  expect(bodies[0].hosts).toHaveLength(100)
  hosts(102)
  await (
    await import('../transport/host-removal-lifecycle')
  ).removeHostAndCloseClient('host-0', vi.fn())
  await settle()
  expect(JSON.parse(state.storage.get('orca:hosts') ?? '[]')).toHaveLength(101)
  expect(bodies.at(-1)?.hosts).toEqual([])
  expect(bodies.at(-1)?.version).toBeGreaterThan(bodies[0].version)
  const quiet = bodies.length
  await vi.advanceTimersByTimeAsync(60_000)
  expect(bodies).toHaveLength(quiet)
})
