import type { MobilePushToken } from './push-token'
import { afterEach, beforeEach, expect, vi } from 'vitest'
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

export function routeDeclarationPorts() {
  return state
}

export function hosts(count: number): void {
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
export const settle = () => vi.advanceTimersByTimeAsync(0)
export function requests(status = 200) {
  const bodies: PushRouteDeclaration[] = []
  const send = vi.fn(async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)))
    return new Response('{}', { status })
  })
  vi.stubGlobal('fetch', send)
  return { bodies, send }
}

export function createRouteDeclarationFixture() {
  let publisher: typeof import('./push-route-declaration')
  let stop: (() => void) | undefined
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
    expect(await publisher.mobilePushRouteKey(() => true).result).toMatchObject({ status: 'ready' })
  })
  afterEach(() => {
    stop?.()
    stop = undefined
    vi.restoreAllMocks()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })
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

  return {
    get publisher() {
      return publisher
    },
    set publisher(value: typeof publisher) {
      publisher = value
    },
    get stop() {
      return stop
    },
    set stop(value: typeof stop) {
      stop = value
    },
    register
  }
}
