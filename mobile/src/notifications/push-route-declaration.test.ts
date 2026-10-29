import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import nacl from 'tweetnacl'
import {
  pushRouteDeclarationContent,
  type PushRouteDeclaration
} from '../../../cloud/packages/push-contract/src/route-declaration'

const state = vi.hoisted(() => ({
  storage: new Map<string, string>(),
  keys: new Map<string, string>(),
  hosts: [{ publicKeyB64: Buffer.alloc(32, 1).toString('base64') }]
}))
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => state.storage.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      state.storage.set(key, value)
    }
  }
}))
vi.mock('../transport/pairing-keychain', () => ({
  readPairingKeychainItem: async (key: string) => state.keys.get(key) ?? null,
  writePairingKeychainItem: async (key: string, value: string) => {
    state.keys.set(key, value)
  }
}))
vi.mock('../transport/host-store', () => ({ loadHostCatalog: async () => state.hosts }))
let publisher: typeof import('./push-route-declaration')
beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  state.storage.clear()
  state.keys.clear()
  state.hosts = [{ publicKeyB64: Buffer.alloc(32, 1).toString('base64') }]
  publisher = await import('./push-route-declaration')
})
afterEach(() => {
  publisher.stopPushRoutePublication()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
const token = {
  platform: 'ios' as const,
  token: 'ab'.repeat(32),
  apnsEnvironment: 'production' as const
}

it('persists a version before sending a signed declaration and retries lost responses identically', async () => {
  const bodies: PushRouteDeclaration[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      const body: PushRouteDeclaration = JSON.parse(String(init.body))
      bodies.push(body)
      expect(Number(state.storage.get('orca:push-route-version'))).toBe(body.version)
      expect(
        nacl.sign.detached.verify(
          Buffer.from(pushRouteDeclarationContent(body)),
          Buffer.from(body.signature, 'base64url'),
          Buffer.from(body.routeKey, 'base64url')
        )
      ).toBe(true)
      if (bodies.length === 1) {
        throw new Error('response lost')
      }
      return new Response('{}')
    })
  )
  const key = await publisher.mobilePushRouteKey()
  expect(key).toHaveLength(43)
  publisher.publishPushRoutes(token, 'https://untrusted.invalid')
  await vi.advanceTimersByTimeAsync(0)
  expect(fetch).not.toHaveBeenCalled()
  publisher.publishPushRoutes(token, 'https://push.onorca.dev')
  await vi.advanceTimersByTimeAsync(0)
  await vi.advanceTimersByTimeAsync(1000)
  expect(bodies).toHaveLength(2)
  expect(bodies[1]).toEqual(bodies[0])
  state.hosts = []
  publisher.refreshPushRoutes()
  await vi.advanceTimersByTimeAsync(0)
  expect(bodies[2].version).toBeGreaterThan(bodies[0].version)
  expect(bodies[2].hosts).toEqual([])
})

it('retries a refused removal with backoff and suspends a rolled-back endpoint until registration renews', async () => {
  const send = vi.fn(async () => new Response('{}', { status: 429 }))
  vi.stubGlobal('fetch', send)
  publisher.publishPushRoutes(token, 'https://push.onorca.dev')
  await vi.advanceTimersByTimeAsync(0)
  state.hosts = []
  publisher.refreshPushRoutes()
  await vi.advanceTimersByTimeAsync(0)
  expect(send).toHaveBeenCalledTimes(2)
  send.mockImplementation(async () => new Response('{}', { status: 404 }))
  await vi.advanceTimersByTimeAsync(1000)
  expect(send).toHaveBeenCalledTimes(3)
  await vi.advanceTimersByTimeAsync(60_000)
  publisher.refreshPushRoutes()
  expect(send).toHaveBeenCalledTimes(3)
  publisher.publishPushRoutes(token, 'https://push.onorca.dev')
  await vi.advanceTimersByTimeAsync(0)
  expect(send).toHaveBeenCalledTimes(4)
})
