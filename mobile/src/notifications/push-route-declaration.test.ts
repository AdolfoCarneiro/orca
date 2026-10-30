import {
  createRouteDeclarationFixture,
  routeDeclarationPorts,
  hosts,
  requests,
  settle
} from './push-route-declaration-ports.test-fixture'
import * as SecureStore from 'expo-secure-store'
import { expect, it, vi } from 'vitest'

const fixture = createRouteDeclarationFixture()
const state = routeDeclarationPorts()
const token = state.token
const register = fixture.register

import nacl from 'tweetnacl'
import { pushRouteDeclarationContent } from '../../../cloud/packages/push-contract/src/route-declaration-content'

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
  fixture.publisher.refreshPushRoutes()
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
  fixture.stop?.()
  vi.resetModules()
  fixture.publisher = await import('./push-route-declaration')
  const registration = await import('./push-registration')
  fixture.stop = registration.startPushTokenSync()
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
  fixture.publisher.refreshPushRoutes()
  await settle()
  fixture.stop()
  fixture.stop = undefined
  vi.resetModules()
  fixture.publisher = await import('./push-route-declaration')
  fixture.stop = (await import('./push-registration')).startPushTokenSync()
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
  fixture.stop = registration.startPushTokenSync()
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
    fixture.publisher.refreshPushRoutes()
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

it.each([
  { count: 4, changes: 0, phase: 'initial' },
  { count: 40, changes: 0, phase: 'initial' },
  ...['initial', 'fresh', 'issued'].flatMap((phase) => [
    { count: 4, changes: 10, phase },
    { count: 40, changes: 100, phase }
  ])
])(
  'bounds actual startup/probe/listener/lease interests for $count hosts and $changes changes behind $phase',
  async ({ count, changes, phase }) => {
    state.keys.clear()
    state.metadataReads = 0
    state.metadataWrites = 0
    vi.resetModules()
    fixture.publisher = await import('./push-route-declaration')
    vi.mocked(SecureStore.getItemAsync).mockClear()
    vi.mocked(SecureStore.setItemAsync).mockClear()
    const heldRead = Promise.withResolvers<string | null>()
    if (phase === 'initial') {
      vi.mocked(SecureStore.getItemAsync).mockImplementationOnce(() => heldRead.promise)
    } else if (phase === 'fresh') {
      vi.mocked(SecureStore.getItemAsync)
        .mockResolvedValueOnce(null)
        .mockImplementationOnce(() => heldRead.promise)
    } else {
      vi.mocked(SecureStore.setItemAsync).mockImplementationOnce(async (key, value) => {
        await heldRead.promise
        state.keys.set(key, value)
      })
    }
    hosts(count)
    const source = await import('./push-route-declaration-build')
    const prepare = fixture.publisher.mobilePushRouteKey
    const interests: {
      handle: ReturnType<typeof prepare>
      predicate: ReturnType<typeof vi.fn<() => boolean>>
      retired: boolean
      calls: number
    }[] = []
    const preparations = vi
      .spyOn(fixture.publisher, 'mobilePushRouteKey')
      .mockImplementation((current) => {
        const predicate = vi.fn(current)
        const handle = prepare(predicate)
        const interest = { handle, predicate, retired: false, calls: 0 }
        interests.push(interest)
        void handle.result.then((result) => {
          if (result.status === 'retired') {
            interest.retired = true
            interest.calls = predicate.mock.calls.length
          }
        })
        return handle
      })
    const { send } = requests()
    const fingerprint = await import('./push-host-fingerprint')
    const hashes = vi.spyOn(fingerprint, 'deriveHostFingerprint')
    const signs = vi.spyOn(nacl.sign, 'detached')
    const { getDevicePushToken } = await import('./push-token')
    const filters = vi.spyOn(
      await import('./notification-delivery-preferences'),
      'loadNotificationDeliveryPreferences'
    )
    const consentReads = vi.spyOn(
      await import('../storage/preferences'),
      'loadPushNotificationsEnabled'
    )
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
    fixture.stop = registration.startPushTokenSync()
    await settle()
    expect(preparations).toHaveBeenCalledTimes(count)
    expect(SecureStore.getItemAsync).toHaveBeenCalledTimes(phase === 'initial' ? 1 : 2)
    expect(SecureStore.setItemAsync).toHaveBeenCalledTimes(phase === 'issued' ? 1 : 0)
    const upstream: { filters: number; consent: number }[] = []
    for (let i = 0; i < changes; i++) {
      const beforeFilters = filters.mock.calls.length
      const beforeConsent = consentReads.mock.calls.length
      state.callbacks.listener?.({ ...token, token: (i + 1).toString(16).padStart(64, '0') })
      await settle()
      expect(source.pushRoutePreparationSnapshotForTests()).toMatchObject({
        keyEntries: count + 1,
        keyTask: 1,
        creator: 0,
        creatorCells: phase === 'initial' ? 0 : 1,
        builder: 1,
        latest: 0,
        builderCallables: 1
      })
      expect(registration.pushRegistrationSnapshotForTests()).toEqual({
        preparations: count,
        runners: count
      })
      upstream.push({
        filters: filters.mock.calls.length - beforeFilters,
        consent: consentReads.mock.calls.length - beforeConsent
      })
      const before = preparations.mock.calls.length
      state.callbacks.listener?.({ ...token, token: (i + 1).toString(16).padStart(64, '0') })
      await settle()
      expect(preparations).toHaveBeenCalledTimes(before)
      expect(interests.filter((interest) => interest.retired)).toHaveLength(count * (i + 1))
    }
    for (const work of upstream) {
      expect(work.filters).toBeGreaterThanOrEqual(count)
      expect(work.filters).toBeLessThanOrEqual(count * 2)
      expect(work.consent).toBeGreaterThanOrEqual(count)
      expect(work.consent).toBeLessThanOrEqual(count * 2 + 1)
    }
    expect(SecureStore.getItemAsync).toHaveBeenCalledTimes(phase === 'initial' ? 1 : 2)
    heldRead.resolve(null)
    await settle()
    for (const reply of replies) {
      reply.resolve()
      await settle()
    }
    expect(SecureStore.getItemAsync).toHaveBeenCalledTimes(phase === 'fresh' ? 3 : 2)
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
    for (const interest of interests.filter((interest) => interest.retired)) {
      expect(interest.predicate).toHaveBeenCalledTimes(interest.calls)
    }
    expect(source.pushRoutePreparationSnapshotForTests()).toMatchObject({
      keyEntries: 0,
      keyTask: 0,
      creator: 0,
      builder: 0,
      latest: 0,
      builderCallables: 0,
      builderPayloads: 0,
      builderBodies: 0
    })
    state.callbacks.listener?.(
      changes ? { ...token, token: changes.toString(16).padStart(64, '0') } : token
    )
    await settle()
    expect(SecureStore.getItemAsync).toHaveBeenCalledTimes(phase === 'fresh' ? 3 : 2)
    expect(SecureStore.setItemAsync).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(15 * 60_000)
    expect(state.loads).toBe(2)
    expect(hashes).toHaveBeenCalledTimes(count * 2)
    expect(signs).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenCalledTimes(2)
    expect(SecureStore.getItemAsync).toHaveBeenCalledTimes(phase === 'fresh' ? 3 : 2)
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

it('completes Off during an issued key write, keeps the committed installation key and sends only after later opt-in', async () => {
  state.keys.clear()
  vi.resetModules()
  fixture.publisher = await import('./push-route-declaration')
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
  fixture.stop = registration.startPushTokenSync()
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
  expect(await fixture.publisher.mobilePushRouteKey(() => true).result).toEqual({
    status: 'ready',
    routeKey: sent[1].routeKey
  })
  expect(SecureStore.setItemAsync).toHaveBeenCalledOnce()
})

it('hands a retired first creator to the current waiter and recovers a committed lost-ack key without replacement', async () => {
  state.keys.clear()
  vi.resetModules()
  fixture.publisher = await import('./push-route-declaration')
  const fresh = Promise.withResolvers<string | null>()
  vi.mocked(SecureStore.getItemAsync)
    .mockResolvedValueOnce(null)
    .mockImplementationOnce(() => fresh.promise)
  vi.mocked(SecureStore.setItemAsync).mockClear()
  let current = true
  const first = fixture.publisher.mobilePushRouteKey(() => current)
  await settle()
  expect(SecureStore.setItemAsync).not.toHaveBeenCalled()
  current = false
  first.release()
  const successor = fixture.publisher.mobilePushRouteKey(() => true)
  await expect(first.result).resolves.toEqual({ status: 'retired' })
  fresh.resolve(null)
  const key = await successor.result
  expect(key).toMatchObject({ status: 'ready', routeKey: expect.any(String) })
  expect(SecureStore.setItemAsync).toHaveBeenCalledTimes(1)
  expect(await fixture.publisher.mobilePushRouteKey(() => true).result).toEqual(key)

  state.keys.clear()
  vi.resetModules()
  fixture.publisher = await import('./push-route-declaration')
  const keychain = await import('../transport/pairing-keychain')
  const queued = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  let prior: Promise<void> | undefined
  vi.mocked(SecureStore.getItemAsync)
    .mockResolvedValueOnce(null)
    .mockImplementationOnce(async () => {
      prior = keychain.writePairingKeychainItem('r5-prior-write', 'owned')
      return null
    })
  vi.mocked(SecureStore.setItemAsync)
    .mockClear()
    .mockImplementationOnce(async (name, value) => {
      entered.resolve()
      await queued.promise
      state.keys.set(name, value)
    })
  const predicate = vi.fn(() => true)
  const waiting = fixture.publisher.mobilePushRouteKey(predicate)
  await settle()
  await entered.promise
  waiting.release()
  await expect(waiting.result).resolves.toEqual({ status: 'retired' })
  const calls = predicate.mock.calls.length
  const next = fixture.publisher.mobilePushRouteKey(() => true)
  expect(
    (await import('./push-route-declaration-build')).pushRoutePreparationSnapshotForTests()
  ).toMatchObject({ keyTask: 1, keyEntries: 1, creator: 0 })
  queued.resolve()
  await prior
  expect(await next.result).toMatchObject({ status: 'ready' })
  expect(predicate).toHaveBeenCalledTimes(calls)
  expect(
    vi
      .mocked(SecureStore.setItemAsync)
      .mock.calls.filter(([name]) => name === 'orca.push-route-key')
  ).toHaveLength(1)

  state.keys.clear()
  vi.resetModules()
  fixture.publisher = await import('./push-route-declaration')
  vi.mocked(SecureStore.setItemAsync).mockImplementationOnce(async (name, value) => {
    state.keys.set(name, value)
    throw new Error('native committed but acknowledgement lost')
  })
  await expect(fixture.publisher.mobilePushRouteKey(() => true).result).resolves.toEqual({
    status: 'unavailable'
  })
  const persisted = state.keys.get('orca.push-route-key')
  if (!persisted) {
    throw new Error('Native write did not commit')
  }
  const recovered = Buffer.from(
    nacl.sign.keyPair.fromSecretKey(Buffer.from(persisted, 'base64')).publicKey
  ).toString('base64url')
  vi.mocked(SecureStore.setItemAsync).mockClear()
  await expect(fixture.publisher.mobilePushRouteKey(() => true).result).resolves.toEqual({
    status: 'ready',
    routeKey: recovered
  })
  expect(SecureStore.setItemAsync).not.toHaveBeenCalled()
})

it('does not replace readable corrupt keys or thrown reads, and retries only on a genuine later caller', async () => {
  for (const failure of ['corrupt', 'read-error'] as const) {
    state.keys.clear()
    state.keys.set('orca.push-route-key', 'invalid')
    vi.resetModules()
    fixture.publisher = await import('./push-route-declaration')
    vi.mocked(SecureStore.setItemAsync).mockClear()
    if (failure === 'read-error') {
      vi.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(new Error('temporarily locked'))
    }
    const results = await Promise.all(
      Array.from({ length: 4 }, () => fixture.publisher.mobilePushRouteKey(() => true).result)
    )
    expect(results).toEqual(Array.from({ length: 4 }, () => ({ status: 'unavailable' })))
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled()
    state.keys.clear()
    expect(await fixture.publisher.mobilePushRouteKey(() => true).result).toMatchObject({
      status: 'ready',
      routeKey: expect.any(String)
    })
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
