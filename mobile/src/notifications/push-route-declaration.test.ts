import type { MobilePushToken } from './push-token'
import * as SecureStore from 'expo-secure-store'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import nacl from 'tweetnacl'
import { pushRouteDeclarationContent } from '../../../cloud/packages/push-contract/src/route-declaration-content'
import type { PushRouteDeclaration } from '../../../cloud/packages/push-contract/src/route-declaration'

const state = vi.hoisted(() => {
  const callbacks: {
    listener?: (token: MobilePushToken) => void
    appState?: (value: string) => void
  } = {}
  return {
    storage: new Map<string, string>(),
    keys: new Map<string, string>(),
    loads: 0,
    metadataReads: 0,
    metadataWrites: 0,
    bytes: 0,
    callbacks,
    token: {
      platform: 'ios' as const,
      token: 'ab'.repeat(32),
      apnsEnvironment: 'production' as const
    }
  }
})
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => {
      if (key.startsWith('orca:pairing-keychain-')) {
        state.metadataReads++
      }
      if (key === 'orca:hosts') {
        state.loads++
        state.bytes += (state.storage.get(key) ?? '').length
      }
      return state.storage.get(key) ?? null
    },
    setItem: async (key: string, value: string) => {
      if (key.startsWith('orca:pairing-keychain-')) {
        state.metadataWrites++
      }
      state.storage.set(key, value)
    },
    removeItem: async (key: string) => {
      state.storage.delete(key)
    }
  }
}))
vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
  getItemAsync: vi.fn(async (key: string) => state.keys.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    state.keys.set(key, value)
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    state.keys.delete(key)
  })
}))
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  AppState: {
    currentState: 'active',
    addEventListener: vi.fn((_: string, callback: (value: string) => void) => {
      state.callbacks.appState = callback
      return {
        remove: () => {
          state.callbacks.appState = undefined
        }
      }
    })
  }
}))
vi.mock('./desktop-notification-channel', () => ({
  ensureDesktopNotificationChannel: async () => {}
}))
vi.mock('./push-token', () => ({
  getDevicePushToken: vi.fn(async () => state.token),
  addPushTokenListener: (listener: typeof state.callbacks.listener) => {
    state.callbacks.listener = listener
    return () => {
      state.callbacks.listener = undefined
    }
  }
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
  vi.clearAllMocks()
  vi.useFakeTimers()
  state.storage.clear()
  state.keys.clear()
  state.loads = 0
  state.bytes = 0
  state.storage.set('orca:pushServiceNotificationsEnabled', 'true')
  hosts(1)
  publisher = await import('./push-route-declaration')
  await publisher.mobilePushRouteKey(() => true)
})
afterEach(() => {
  stop?.()
  stop = undefined
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

async function register(gatewayOrigin = 'https://push.onorca.dev') {
  const registration = await import('./push-registration')
  stop ??= registration.startPushTokenSync()
  registration.attachPushRegistration('host-0', {
    sendRequest: async (method: string) => ({
      id: 'req',
      ok: true as const,
      result:
        method === 'status.get'
          ? {
              capabilities: [
                registration.NOTIFICATIONS_REMOTE_PUSH_CAPABILITY,
                'notifications.push-route-key.v1'
              ]
            }
          : { registered: true, gatewayOrigin }
    })
  })
  await settle()
}

it('persists signed versions before sending and retries a lost response identically', async () => {
  const { bodies, send } = requests()
  send.mockImplementationOnce(async (_url, init) => {
    bodies.push(JSON.parse(String(init.body)))
    throw new Error('response lost')
  })
  await register('https://untrusted.invalid')
  await settle()
  expect(fetch).not.toHaveBeenCalled()
  await register()
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

it('retains immutable transport bytes while a later lease renewal is due, then publishes one higher version', async () => {
  const { bodies, send } = requests(503)
  await register()
  await vi.advanceTimersByTimeAsync(15 * 60_000)
  const immutable = bodies[0]
  if (!immutable) {
    throw new Error('Missing initial real publication')
  }
  expect(bodies.every((body) => JSON.stringify(body) === JSON.stringify(immutable))).toBe(true)
  expect(state.loads).toBe(1)
  send.mockImplementation(async (_url, init) => {
    bodies.push(JSON.parse(String(init.body)))
    return new Response('{}')
  })
  await vi.advanceTimersByTimeAsync(60_000)
  const latest = bodies.at(-1)
  expect(latest?.version).toBeGreaterThan(immutable.version)
  expect(state.loads).toBe(2)
  const settled = send.mock.calls.length
  await vi.advanceTimersByTimeAsync(60_000)
  expect(send).toHaveBeenCalledTimes(settled)
})

it('recovers saved key/version with current token and removes an unreachable host after cold startup', async () => {
  hosts(2)
  const { bodies, send } = requests()
  await register()
  await settle()
  const prior = bodies[0]
  stop?.()
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
  let live = true
  const client = {
    sendRequest: vi.fn(async (method: string) => {
      if (method === 'status.get') {
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
  stop = registration.startPushTokenSync()
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
  registration.attachPushRegistration('host-0', client)
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
  await register()
  await settle()
  await register()
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
  await register()
  await settle()
  expect(send).toHaveBeenCalledTimes(parked + 1)
})

it.each([4, 40])(
  'coalesces actual startup/probe/listener/lease work for %s staggered hosts',
  async (count) => {
    state.keys.clear()
    state.metadataReads = 0
    state.metadataWrites = 0
    vi.resetModules()
    publisher = await import('./push-route-declaration')
    vi.mocked(SecureStore.getItemAsync).mockClear()
    vi.mocked(SecureStore.setItemAsync).mockClear()
    const heldRead = Promise.withResolvers<string | null>()
    vi.mocked(SecureStore.getItemAsync).mockImplementationOnce(() => heldRead.promise)
    hosts(count)
    const preparations = vi.spyOn(publisher, 'mobilePushRouteKey')
    const { send } = requests()
    const fingerprint = await import('./push-host-fingerprint')
    const hashes = vi.spyOn(fingerprint, 'deriveHostFingerprint')
    const signs = vi.spyOn(nacl.sign, 'detached')
    const { getDevicePushToken } = await import('./push-token')
    const registration = await import('./push-registration')
    const replies = Array.from({ length: count }, () => Promise.withResolvers<void>())
    const clients = replies.map((gate) => ({
      sendRequest: vi.fn(async (method: string) => {
        if (method !== 'status.get') {
          await gate.promise
        }
        return {
          id: 'req',
          ok: true as const,
          result:
            method === 'status.get'
              ? {
                  capabilities: [
                    registration.NOTIFICATIONS_REMOTE_PUSH_CAPABILITY,
                    'notifications.push-route-key.v1'
                  ]
                }
              : { registered: true, gatewayOrigin: 'https://push.onorca.dev' }
        }
      })
    }))
    clients.forEach((client, i) => registration.attachPushRegistration(`host-${i}`, client))
    await settle()
    expect(getDevicePushToken).not.toHaveBeenCalled()
    stop = registration.startPushTokenSync()
    await settle()
    expect(preparations).toHaveBeenCalledTimes(count)
    expect(SecureStore.getItemAsync).toHaveBeenCalledTimes(1)
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled()
    heldRead.resolve(null)
    await settle()
    for (const reply of replies) {
      reply.resolve()
      await settle()
    }
    expect(SecureStore.getItemAsync).toHaveBeenCalledTimes(2)
    expect(SecureStore.setItemAsync).toHaveBeenCalledTimes(1)
    expect(state.keys.size).toBe(1)
    expect(state.metadataReads).toBe(1)
    expect(state.metadataWrites).toBe(0)
    expect(state.loads).toBe(1)
    expect(state.bytes).toBe((state.storage.get('orca:hosts') ?? '').length)
    expect(hashes).toHaveBeenCalledTimes(count)
    expect(signs).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledTimes(1)
    expect(getDevicePushToken).toHaveBeenCalledOnce()
    for (const client of clients) {
      expect(
        client.sendRequest.mock.calls.filter(([method]) => method === 'notifications.registerPush')
      ).toHaveLength(1)
    }
    state.callbacks.listener?.(token)
    await settle()
    expect(SecureStore.getItemAsync).toHaveBeenCalledTimes(2)
    expect(SecureStore.setItemAsync).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(15 * 60_000)
    expect(state.loads).toBe(2)
    expect(hashes).toHaveBeenCalledTimes(count * 2)
    expect(signs).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenCalledTimes(2)
    expect(SecureStore.getItemAsync).toHaveBeenCalledTimes(2)
    expect(SecureStore.setItemAsync).toHaveBeenCalledTimes(1)
    expect(state.metadataReads).toBe(1)
    expect(state.metadataWrites).toBe(0)
    for (const client of clients) {
      expect(
        client.sendRequest.mock.calls.filter(([method]) => method === 'notifications.registerPush')
      ).toHaveLength(2)
    }
  }
)

it.each(['saved', 'missing'] as const)(
  'releases obsolete %s key preparations at every owner boundary and preserves current successor duty',
  async (kind) => {
    const { AppState } = await import('react-native')
    const actions = [
      'disable',
      'stop',
      'restart',
      'detach',
      're-pair',
      'remove',
      'token',
      'renewal',
      'background',
      'filter-failure',
      'consent-failure'
    ] as const
    for (const action of actions) {
      stop?.()
      stop = undefined
      vi.resetModules()
      vi.clearAllMocks()
      AppState.currentState = 'active'
      state.storage.set('orca:pushServiceNotificationsEnabled', 'true')
      state.storage.delete('orca:push-route-version')
      if (kind === 'missing') {
        state.keys.clear()
      }
      const pending = Promise.withResolvers<string | null>()
      vi.mocked(SecureStore.getItemAsync).mockImplementationOnce(() => pending.promise)
      publisher = await import('./push-route-declaration')
      const { send } = requests()
      const registration = await import('./push-registration')
      const client = () => ({
        sendRequest: vi.fn(async (method: string) => ({
          id: 'key-race',
          ok: true as const,
          result:
            method === 'status.get'
              ? {
                  capabilities: [
                    registration.NOTIFICATIONS_REMOTE_PUSH_CAPABILITY,
                    'notifications.push-route-key.v1'
                  ]
                }
              : { registered: true, gatewayOrigin: 'https://push.onorca.dev', unregistered: true }
        }))
      })
      const old = client()
      stop = registration.startPushTokenSync()
      const detach = registration.attachPushRegistration('host-0', old)
      await settle()
      const registerCalls = () =>
        old.sendRequest.mock.calls.filter(([method]) => method === 'notifications.registerPush')
      expect(registerCalls()).toHaveLength(0)
      const replacement = client()
      let recover: (() => void) | undefined
      if (action === 'disable') {
        await registration.setRemotePushEnabled(false)
      } else if (action === 'restart' || action === 'stop') {
        stop()
        if (action === 'restart') {
          stop = registration.startPushTokenSync()
        }
      } else if (action === 'detach') {
        detach()
        registration.attachPushRegistration('host-0', replacement)
      } else if (action === 're-pair' || action === 'remove') {
        // Removal and its real unregister finish before the physical read is released.
        recover = await registration.unregisterPushForRemovedHost('host-0')
        if (action === 're-pair') {
          registration.attachPushRegistration('host-0', replacement)
        }
      } else if (action === 'token') {
        state.callbacks.listener?.({ ...token, token: 'cd'.repeat(32) })
      } else if (action === 'renewal') {
        state.callbacks.appState?.('active')
      } else if (action === 'background') {
        AppState.currentState = 'background'
        state.callbacks.appState?.('background')
      } else {
        const storage = (await import('@react-native-async-storage/async-storage')).default
        const save = vi
          .spyOn(storage, 'setItem')
          .mockRejectedValueOnce(new Error('local persistence failed'))
        const result =
          action === 'consent-failure'
            ? registration.setRemotePushEnabled(false)
            : registration.setNotificationDeliveryPreferences({
                onlyWhenDesktopAway: false,
                sound: false,
                suppressWhileViewing: true
              })
        await expect(result).rejects.toThrow('local persistence failed')
        save.mockRestore()
      }
      await settle()
      expect(registerCalls()).toHaveLength(0)
      if (action === 'disable' || action === 'remove' || action === 're-pair') {
        expect(
          old.sendRequest.mock.calls.some(([method]) => method === 'notifications.unregisterPush')
        ).toBe(true)
      }
      pending.resolve(kind === 'saved' ? (state.keys.get('orca.push-route-key') ?? null) : null)
      await settle()
      const absent =
        action === 'disable' || action === 'stop' || action === 'background' || action === 'remove'
      expect(registerCalls()).toHaveLength(
        absent || action === 're-pair' || action === 'detach' ? 0 : 1
      )
      expect(
        replacement.sendRequest.mock.calls.filter(
          ([method]) => method === 'notifications.registerPush'
        )
      ).toHaveLength(action === 're-pair' || action === 'detach' ? 1 : 0)
      expect(SecureStore.setItemAsync).toHaveBeenCalledTimes(kind === 'missing' && !absent ? 1 : 0)
      expect(send).toHaveBeenCalledTimes(absent ? 0 : 1)
      if (action === 'remove') {
        recover?.()
        await settle()
        expect(registerCalls()).toHaveLength(1)
      }
    }
  }
)

it('completes Off during an issued key write, keeps the committed installation key and sends only after later opt-in', async () => {
  state.keys.clear()
  vi.resetModules()
  publisher = await import('./push-route-declaration')
  const registration = await import('./push-registration')
  const issued = Promise.withResolvers<void>()
  const held = Promise.withResolvers<void>()
  vi.mocked(SecureStore.setItemAsync)
    .mockClear()
    .mockImplementationOnce(async (key, value) => {
      issued.resolve()
      await held.promise
      state.keys.set(key, value)
    })
  const client = {
    sendRequest: vi.fn(async (method: string, _params?: unknown) => ({
      id: 'write-race',
      ok: true as const,
      result:
        method === 'status.get'
          ? {
              capabilities: [
                registration.NOTIFICATIONS_REMOTE_PUSH_CAPABILITY,
                'notifications.push-route-key.v1'
              ]
            }
          : { registered: true, gatewayOrigin: 'https://push.onorca.dev', unregistered: true }
    }))
  }
  requests()
  stop = registration.startPushTokenSync()
  registration.attachPushRegistration('host-0', client)
  await settle()
  await issued.promise
  await registration.setRemotePushEnabled(false)
  await settle()
  expect(
    client.sendRequest.mock.calls.some(([method]) => method === 'notifications.unregisterPush')
  ).toBe(true)
  held.resolve()
  await settle()
  expect(
    client.sendRequest.mock.calls.filter(([method]) => method === 'notifications.registerPush')
  ).toEqual([])
  expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled()
  await registration.setRemotePushEnabled(true)
  await settle()
  const sent = client.sendRequest.mock.calls.find(
    ([method]) => method === 'notifications.registerPush'
  )
  if (!sent || !sent[1] || typeof sent[1] !== 'object' || !('routeKey' in sent[1])) {
    throw new Error('Missing keyed register')
  }
  expect(sent[1].routeKey).toBe(await publisher.mobilePushRouteKey(() => true))
  expect(SecureStore.setItemAsync).toHaveBeenCalledOnce()
})

it('hands a retired first creator to the current waiter and recovers a committed lost-ack key without replacement', async () => {
  state.keys.clear()
  vi.resetModules()
  publisher = await import('./push-route-declaration')
  const fresh = Promise.withResolvers<string | null>()
  vi.mocked(SecureStore.getItemAsync)
    .mockResolvedValueOnce(null)
    .mockImplementationOnce(() => fresh.promise)
  vi.mocked(SecureStore.setItemAsync).mockClear()
  let current = true
  const first = publisher.mobilePushRouteKey(() => current)
  await settle()
  expect(SecureStore.setItemAsync).not.toHaveBeenCalled()
  current = false
  const successor = publisher.mobilePushRouteKey(() => true)
  fresh.resolve(null)
  await expect(first).resolves.toBeUndefined()
  const key = await successor
  expect(key).toBeTypeOf('string')
  expect(SecureStore.setItemAsync).toHaveBeenCalledTimes(1)
  expect(await publisher.mobilePushRouteKey(() => true)).toBe(key)

  state.keys.clear()
  vi.resetModules()
  publisher = await import('./push-route-declaration')
  vi.mocked(SecureStore.setItemAsync).mockImplementationOnce(async (name, value) => {
    state.keys.set(name, value)
    throw new Error('native committed but acknowledgement lost')
  })
  await expect(publisher.mobilePushRouteKey(() => true)).resolves.toBeUndefined()
  const persisted = state.keys.get('orca.push-route-key')
  if (!persisted) {
    throw new Error('Native write did not commit')
  }
  const recovered = Buffer.from(
    nacl.sign.keyPair.fromSecretKey(Buffer.from(persisted, 'base64')).publicKey
  ).toString('base64url')
  vi.mocked(SecureStore.setItemAsync).mockClear()
  await expect(publisher.mobilePushRouteKey(() => true)).resolves.toBe(recovered)
  expect(SecureStore.setItemAsync).not.toHaveBeenCalled()
})

it('does not replace readable corrupt keys or thrown reads, and retries only on a genuine later caller', async () => {
  for (const failure of ['corrupt', 'read-error'] as const) {
    state.keys.clear()
    state.keys.set('orca.push-route-key', 'invalid')
    vi.resetModules()
    publisher = await import('./push-route-declaration')
    vi.mocked(SecureStore.setItemAsync).mockClear()
    if (failure === 'read-error') {
      vi.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(new Error('temporarily locked'))
    }
    const results = await Promise.all(
      Array.from({ length: 4 }, () => publisher.mobilePushRouteKey(() => true))
    )
    expect(results).toEqual([undefined, undefined, undefined, undefined])
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled()
    state.keys.clear()
    expect(await publisher.mobilePushRouteKey(() => true)).toBeTypeOf('string')
    expect(SecureStore.setItemAsync).toHaveBeenCalledOnce()
  }
})

it('withdraws the prior100 declaration for the exact102 then removed→101 catalog without truncation', async () => {
  hosts(100)
  const { bodies } = requests()
  await register()
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
