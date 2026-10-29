import { expect, it, vi } from 'vitest'
import nacl from 'tweetnacl'
import {
  companion,
  httpResult,
  integer,
  post,
  record,
  text
} from '../../../src/shared/push-owner-integration.test-fixture'
import type { RpcOperationSender } from '../transport/rpc-operation-sender'
import type { MobilePushToken } from './push-token'
import { AppState } from 'react-native'
import {
  attachPushRegistration,
  resetPushRegistrationForTests,
  startPushTokenSync
} from './push-registration'

type Ports = {
  storage: Map<string, string>
  keys: Map<string, string>
  listener?: (token: MobilePushToken) => void
  foreground?: (state: string) => void
  finalFailure?: ReturnType<typeof Promise.withResolvers<void>>
  fault: string
  reads: number
  writes: number
  bytes: number
  native: MobilePushToken
}
const ports = vi.hoisted((): Ports => ({
  storage: new Map(),
  keys: new Map(),
  fault: '',
  reads: 0,
  writes: 0,
  bytes: 0,
  native: { platform: 'ios', token: 'a'.repeat(64), apnsEnvironment: 'production' }
}))
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => {
      if (key === 'orca:push-route-version') {
        ports.reads++
      }
      if (key === 'orca:hosts') {
        ports.bytes += (ports.storage.get(key) ?? '').length
      }
      const fault = ports.fault
      if (fault === 'catalog-race' && key === 'orca:hosts') {
        if (ports.reads === 3) {
          await ports.finalFailure?.promise
        }
        throw new Error('Controlled final catalog failure')
      }
      if (
        (ports.fault === 'catalog-read' && key === 'orca:hosts') ||
        (ports.fault === 'version-read' && key === 'orca:push-route-version')
      ) {
        throw new Error('Controlled storage read failure')
      }
      if (ports.fault === 'non-array' && key === 'orca:hosts') {
        return '{}'
      }
      return ports.storage.get(key) ?? null
    },
    setItem: async (key: string, value: string) => {
      if (key === 'orca:push-route-version') {
        ports.writes++
        if (ports.fault === 'version-write') {
          throw new Error('Controlled storage write failure')
        }
      }
      ports.storage.set(key, value)
    }
  }
}))
vi.mock('../transport/pairing-keychain', () => ({
  readPairingKeychainItem: async (key: string) => ports.keys.get(key) ?? null,
  writePairingKeychainItem: async (key: string, value: string) => {
    ports.keys.set(key, value)
  }
}))
vi.mock('react-native', () => ({
  AppState: {
    currentState: 'active',
    addEventListener: (_: string, callback: typeof ports.foreground) => {
      ports.foreground = callback
      return {
        remove: () => {
          ports.foreground = undefined
        }
      }
    }
  }
}))
vi.mock('./desktop-notification-channel', () => ({
  ensureDesktopNotificationChannel: async () => {}
}))
vi.mock('./push-token', () => ({
  getDevicePushToken: async () => ports.native,
  addPushTokenListener: (callback: typeof ports.listener) => {
    ports.listener = callback
    return () => {
      ports.listener = undefined
    }
  }
}))

it('runs the actual current-owner, prepared sender and signed publisher against live parent desktop/cloud actors', async () => {
  const base = text(process.env.ORCA_PUSH_OWNER_BRIDGE)
  const nativeFetch = globalThis.fetch
  let stop: (() => void) | undefined
  const detach: (() => void)[] = []
  let renewalPhase = false
  let clock = 1_700_000_000_000
  const drain = () => vi.advanceTimersByTimeAsync(0)
  const client = (host: string): RpcOperationSender => ({
    sendRequest: async (method, params, options) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Actual transport response timeout')),
          options?.timeoutMs ?? 5000
        )
      })
      const response = post(base, '/rpc', { host, method, params }).then(async (result) => {
        await post(base, '/event', {
          name: `observed:${host}:${record(params ?? {}).token ?? method}`,
          data: result
        })
        if (renewalPhase && method === 'notifications.registerPush') {
          await post(base, '/event', { name: `renewed:${host}`, data: result })
        }
        return { id: 'mobile-transport', ok: true as const, result }
      })
      try {
        return await Promise.race([response, timeout])
      } finally {
        clearTimeout(timer)
      }
    }
  })
  vi.useFakeTimers({
    toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']
  })
  vi.setSystemTime(clock)
  // Only actual publisher HTTP goes over this port; bridge control fetches use the saved native function.
  vi.stubGlobal('fetch', ((url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).startsWith(base)) {
      return nativeFetch(url, init)
    }
    return nativeFetch(base + '/gateway', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: String(url),
        method: init?.method ?? 'GET',
        headers: Object.fromEntries(new Headers(init?.headers)),
        body: init?.body
      })
    }).then(async (response) => httpResult(await response.json()))
  }) satisfies typeof fetch)
  try {
    await companion('mobile', async (op, data) => {
      if (op === 'start') {
        ports.storage.set('orca:pushServiceNotificationsEnabled', 'true')
        ports.storage.set('orca:hosts', JSON.stringify(data.profiles))
        ports.storage.set('orca:push-route-version', String(clock - 1))
        const key = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7))
        ports.keys.set('orca.push-route-key', Buffer.from(key.secretKey).toString('base64'))
        // Attach before root deliberately exercises the independent effect ordering.
        for (const host of ['A', 'B']) {
          detach.push(attachPushRegistration(host, client(host)))
        }
        stop = startPushTokenSync()
      } else if (op === 'token') {
        ports.native = { platform: 'ios', token: text(data.token), apnsEnvironment: 'production' }
        if (!ports.listener) {
          throw new Error('Native owner listener missing')
        }
        ports.listener(ports.native)
      } else if (op === 'advance') {
        const delta = integer(data.delta)
        clock += delta
        await vi.advanceTimersByTimeAsync(delta)
      } else if (op === 'foreground') {
        renewalPhase = true
        if (!ports.foreground) {
          throw new Error('Missing renewal owner')
        }
        ports.foreground('active')
      } else if (op === 'fault') {
        ports.fault = text(data.kind)
        if (ports.fault === 'catalog-race') {
          ports.finalFailure = Promise.withResolvers<void>()
        }
        ports.reads = 0
        ports.writes = 0
        ports.foreground?.('active')
      } else if (op === 'disconnect') {
        for (const release of detach.splice(0)) {
          release()
        }
      } else if (op === 'background') {
        AppState.currentState = 'background'
      } else if (op === 'repair') {
        ports.fault = ''
        AppState.currentState = 'active'
        if (!ports.foreground) {
          throw new Error('Lifecycle owner missing')
        }
        ports.foreground('active')
      } else if (op === 'release-failure') {
        ports.finalFailure?.resolve()
      } else if (op === 'restart') {
        stop?.()
        stop = startPushTokenSync()
      } else if (op !== 'drain' && op !== 'stats') {
        throw new Error(`Unknown mobile command ${op}`)
      }
      await drain()
      return {
        reads: ports.reads,
        writes: ports.writes,
        bytes: ports.bytes,
        version: ports.storage.get('orca:push-route-version')
      }
    })
    expect(ports.storage.get('orca:pushServiceNotificationsEnabled')).toBe('true')
  } finally {
    stop?.()
    resetPushRegistrationForTests()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  }
}, 120_000)
