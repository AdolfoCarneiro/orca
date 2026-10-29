import { ports } from './push-owner-native-ports.test-fixture'
import { expect, it, vi } from 'vitest'
import nacl from 'tweetnacl'
import {
  companion,
  httpResult,
  integer,
  post,
  record,
  text
} from '../../../cloud/apps/push/src/push-owner-integration.test-fixture'
import type { RpcOperationSender } from '../transport/rpc-operation-sender'
import { AppState } from 'react-native'
import * as publication from './push-route-declaration'
import {
  attachPushRegistration,
  resetPushRegistrationForTests,
  startPushTokenSync
} from './push-registration'

it('runs the actual current-owner, prepared sender and signed publisher against live parent desktop/cloud actors', async () => {
  const base = text(process.env.ORCA_PUSH_OWNER_BRIDGE)
  const nativeFetch = globalThis.fetch
  let stop: (() => void) | undefined
  const detach: (() => void)[] = []
  let renewalPhase = false
  let firstUse = true
  const bothPreparations = Promise.withResolvers<void>()
  const prepare = publication.mobilePushRouteKey
  let preparationCount = 0
  const preparations = vi.spyOn(publication, 'mobilePushRouteKey').mockImplementation((current) => {
    const result = prepare(current)
    if (++preparationCount === 2) {
      bothPreparations.resolve()
    }
    return result
  })
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
          name: `${firstUse ? 'first-observed' : 'observed'}:${host}:${record(params ?? {}).token ?? method}`,
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
        expect(ports.keys.size).toBe(0)
        expect(ports.storage.has('orca:push-route-version')).toBe(false)
        ports.keyRead = Promise.withResolvers<void>()
        ports.keyReadStarted = Promise.withResolvers<void>()
        stop = startPushTokenSync()
        await ports.keyReadStarted.promise
      } else if (op === 'attach') {
        expect(ports.keyReads).toBe(1)
        for (const host of ['A', 'B']) {
          detach.push(attachPushRegistration(host, client(host)))
        }
        await bothPreparations.promise
      } else if (op === 'release-key') {
        expect(preparations).toHaveBeenCalledTimes(2)
        expect(preparations.mock.calls.every(([current]) => current())).toBe(true)
        expect(ports.keyWrites).toBe(0)
        expect(ports.keyReads).toBe(1)
        ports.keyRead?.resolve()
      } else if (op === 'begin-rollover') {
        firstUse = false
        ports.native = { platform: 'ios', token: 'a'.repeat(64), apnsEnvironment: 'production' }
        if (!ports.listener) {
          throw new Error('Missing native owner')
        }
        ports.listener(ports.native)
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
        ports.foreground?.('background')
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
        preparations: preparations.mock.calls.length,
        keyReads: ports.keyReads,
        keyWrites: ports.keyWrites,
        metadataReads: ports.metadataReads,
        metadataWrites: ports.metadataWrites,
        routeKey: ports.keys.has('orca.push-route-key')
          ? Buffer.from(
              nacl.sign.keyPair.fromSecretKey(
                Buffer.from(text(ports.keys.get('orca.push-route-key')), 'base64')
              ).publicKey
            ).toString('base64url')
          : null,
        version: ports.storage.get('orca:push-route-version')
      }
    })
    expect(ports.storage.get('orca:pushServiceNotificationsEnabled')).toBe('true')
  } finally {
    ports.keyRead?.resolve()
    ports.finalFailure?.resolve()
    stop?.()
    preparations.mockRestore()
    resetPushRegistrationForTests()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  }
}, 120_000)
