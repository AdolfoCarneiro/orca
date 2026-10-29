import { afterEach, describe, expect, it } from 'vitest'
import nacl from 'tweetnacl'
import { pushRouteDeclarationContent } from '@orca-cloud/push-contract'
import { PushDeviceRegistryStore } from './device-registry-store.js'
import { declarePushRoutes } from './push-route-declarations.js'
import { buildPushDelivery } from './push-delivery-message.js'
import { PushDispatcher } from './push-dispatcher.js'
import { ApnsClient } from './apns-client.js'
import { DurablePushStore } from './durable-push-store.js'
import { pushDestination } from './push-occurrence-admission.js'
import {
  cleanupDurablePushFixtures,
  durablePushTestDatabaseUrl,
  fixture,
  notification
} from './durable-push-store.test-fixture.js'

const A = 'AAAAAAAAAAAAAAAA'
const B = 'BBBBBBBBBBBBBBBB'
const origin = B
const occurrence = 'o'.repeat(43)
afterEach(cleanupDurablePushFixtures)

async function setup() {
  const f = await fixture()
  const devices = new PushDeviceRegistryStore(f.db, f.clock)
  const key = nacl.sign.keyPair()
  const routeKey = Buffer.from(key.publicKey).toString('base64url')
  for (const hostFingerprint of [A, B])
    await devices.upsert({
      hostFingerprint,
      deviceId: 'phone',
      platform: 'ios',
      token: 'ab'.repeat(32),
      apnsEnvironment: 'production',
      routeKey
    })
  const [a] = await devices
    .findOwned(
      A,
      (await devices.list(A)).map((d) => d.registrationId)
    )
    .then((m) => [...m.values()])
  const [b] = await devices
    .findOwned(
      B,
      (await devices.list(B)).map((d) => d.registrationId)
    )
    .then((m) => [...m.values()])
  const declare = async (hosts: string[], version = 1, signingKey = key) => {
    const body = {
      v: 1 as const,
      platform: 'ios' as const,
      token: a.token,
      apnsEnvironment: 'production' as const,
      routeKey,
      version,
      hosts
    }
    return declarePushRoutes(
      f.db,
      {
        ...body,
        signature: Buffer.from(
          nacl.sign.detached(Buffer.from(pushRouteDeclarationContent(body)), signingKey.secretKey)
        ).toString('base64url')
      },
      f.clock()
    )
  }
  expect(await declare([A, B])).toBe(true)
  const alert = { ...notification(1), notificationId: 'subject', origin, occurrence }
  await f.store.accept(A, a.registrationId, alert)
  await f.store.accept(B, b.registrationId, alert)
  const first = (await f.store.claim())!
  const second = (await f.store.claim())!
  const device = (queued: typeof first) => (queued.hostFingerprint === A ? a : b)
  return { ...f, devices, declare, a, b, alert, first, second, device }
}

describe('occurrence admission', () => {
  it.skipIf(!durablePushTestDatabaseUrl).each(['sent', 'dismissed'] as const)(
    'waits for Postgres contention before committing %s without resending',
    async (outcome) => {
      const f = await setup()
      if (outcome === 'dismissed') await f.store.defer(f.first)
      let attempted!: () => void
      const atAttempt = new Promise<void>((resolve) => (attempted = resolve))
      const contended = new DurablePushStore(
        {
          ...f.db,
          transaction: (run) =>
            f.db.transaction((tx) =>
              run({
                ...tx,
                lockScope: async (key) => {
                  attempted()
                  await tx.lockScope(key)
                }
              })
            )
        },
        f.clock
      )
      const admission = contended.admission(f.first)
      await admission.acquire(f.device(f.first))
      let releaseAgain!: () => void
      const blockedAgain = new Promise<void>((resolve) => (releaseAgain = resolve))
      let heldAgain!: () => void
      const atHeldAgain = new Promise<void>((resolve) => (heldAgain = resolve))
      const blocker = f.db.transaction(async (tx) => {
        await tx.lockScope(
          `push-claim:${JSON.stringify([pushDestination(f.device(f.first)), origin, occurrence])}`
        )
        heldAgain()
        await blockedAgain
      })
      await atHeldAgain
      const { origin: _origin, occurrence: _occurrence, ...legacy } = f.alert
      const completed =
        outcome === 'sent'
          ? admission.finalize(true)
          : contended.accept(f.first.hostFingerprint, f.first.registrationId, {
              ...legacy,
              kind: 'dismiss',
              notificationSeq: 2
            })
      try {
        await atAttempt
        expect((await f.db.query('SELECT state FROM push_occurrence_claims'))[0].state).toBe(
          'inflight'
        )
      } finally {
        releaseAgain()
        await blocker
      }
      await completed
      expect((await f.db.query('SELECT state FROM push_occurrence_claims'))[0].state).toBe(outcome)
      if (outcome === 'dismissed') {
        expect(
          await f.db.query('SELECT batch_id FROM push_delivery_batches WHERE batch_id = ?', [
            f.first.id
          ])
        ).toEqual([])
      }
      expect(await f.store.admission(f.second).acquire(f.device(f.second))).toBe('superseded')
    }
  )

  it('waits quietly, releases failed winners, and never resends a recorded receipt after removal', async () => {
    const f = await setup()
    const winner = f.store.admission(f.first)
    const loser = f.store.admission(f.second)
    expect(await winner.acquire(f.device(f.first))).toBe('admitted')
    for (let i = 0; i < 5; i++) {
      expect(await loser.acquire(f.device(f.second))).toBe('deferred')
      await f.store.defer(f.second)
      f.advance(1000)
      f.second = (await f.store.claim())!
    }
    expect(f.second.attempts).toBe(1)
    await winner.finalize(false)
    const successor = f.store.admission(f.second)
    expect(await successor.acquire(f.device(f.second))).toBe('admitted')
    await successor.finalize(true)
    expect(await f.declare([f.first.hostFingerprint], 2)).toBe(true)
    expect(await winner.acquire(f.device(f.first))).toBe('superseded')
  })

  it('serializes expired takeover and fences a stale completion', async () => {
    const f = await setup()
    const stale = f.store.admission(f.first)
    expect(await stale.acquire(f.device(f.first))).toBe('admitted')
    f.advance(30_001)
    const successor = f.store.admission({ ...f.first, lease: 'successor' })
    const peer = f.store.admission(f.second)
    const results = await Promise.all([
      successor.acquire(f.device(f.first)),
      peer.acquire(f.device(f.second))
    ])
    expect(results.filter((result) => result === 'admitted')).toHaveLength(1)
    await stale.finalize(false)
    const [row] = await f.db.query('SELECT * FROM push_occurrence_claims')
    expect(row.attempt).not.toBe(f.first.lease)
    const admitted = results[0] === 'admitted' ? successor : peer
    await admitted.finalize(true)
    expect(
      await admitted.acquire(results[0] === 'admitted' ? f.device(f.first) : f.device(f.second))
    ).toBe('superseded')
  })

  it('keeps an in-flight dismissal monotonic when the provider then fails', async () => {
    const f = await setup()
    const winner = f.store.admission(f.first)
    expect(await winner.acquire(f.device(f.first))).toBe('admitted')
    const { origin: _origin, occurrence: _occurrence, ...legacy } = f.alert
    await f.store.accept(f.first.hostFingerprint, f.first.registrationId, {
      ...legacy,
      kind: 'dismiss',
      notificationSeq: 2
    })
    await winner.finalize(false)
    expect(await f.store.admission(f.second).acquire(f.device(f.second))).toBe('superseded')
    await f.store.accept(A, f.a.registrationId, { ...f.alert, notificationSeq: 1 })
    expect((await f.db.query('SELECT state FROM push_occurrence_claims'))[0].state).toBe(
      'dismissed'
    )
  })

  it('lets a near-expiry waiter send after failure without consuming retry backoff', async () => {
    const f = await setup()
    const winner = f.store.admission(f.first)
    await winner.acquire(f.device(f.first))
    f.advance(299_500)
    await winner.renew()
    await f.store.renew(f.first)
    expect(await f.store.admission(f.second).acquire(f.device(f.second))).toBe('deferred')
    await f.store.defer(f.second)
    expect(await f.store.pendingCount(f.second.registrationId)).toBe(1)
    await winner.finalize(false)
    f.advance(499)
    const retried = (await f.store.claim())!
    expect(retried.attempts).toBe(1)
    expect(await f.store.admission(retried).acquire(f.device(retried))).toBe('admitted')
  })

  it('does not let a foreign route-key receipt suppress the phone or skipped copies replace it', async () => {
    const f = await setup()
    const admitted = f.store.admission(f.first)
    await admitted.acquire(f.device(f.first))
    await admitted.finalize(true)
    await f.db.query('UPDATE push_occurrence_claims SET winner_route_key = ?', ['foreign'])
    expect(await f.store.admission(f.second).acquire(f.device(f.second))).toBe('admitted')
    await f.declare([f.second.hostFingerprint], 2)
    expect(await f.store.admission(f.first).acquire(f.device(f.first))).toBe('skipped')
    const shared = buildPushDelivery({
      ...f.second,
      notification: f.alert,
      expiresAt: f.second.expiresAt
    })
    const sent: (typeof shared)[] = []
    const dispatcher = new PushDispatcher({
      devices: f.devices,
      apns: Object.assign(Object.create(ApnsClient.prototype), {
        send: async (delivery: typeof shared) => {
          sent.push(structuredClone(delivery))
          return { status: 'sent' as const }
        }
      })
    })
    await dispatcher.sendOnce(shared, f.store.admission(f.second))
    const skipped = buildPushDelivery({
      ...f.first,
      notification: f.alert,
      expiresAt: f.first.expiresAt
    })
    await dispatcher.sendOnce(skipped, f.store.admission(f.first))
    expect(sent[0].orca.origin).toBe(origin)
    expect(sent[1].orca.origin).toBeUndefined()
    expect(sent[1].collapseId).not.toBe(sent[0].collapseId)
  })

  it('acknowledges lost declaration responses, orders versions, and rejects unproven declarations', async () => {
    const f = await setup()
    expect(await f.declare([B, A], 1)).toBe(true)
    expect(await f.declare([B], 1)).toBe(false)
    expect(await f.declare([B], 2, nacl.sign.keyPair())).toBe(false)
    await Promise.all([f.declare([A], 2), f.declare([B], 3)])
    expect(await f.declare([A, B], 2)).toBe(false)
    expect((await f.db.query('SELECT hosts_json FROM push_route_declarations'))[0].hosts_json).toBe(
      JSON.stringify([B])
    )
    await f.db.query('UPDATE push_devices SET route_key = NULL')
    expect(await f.declare([A, B], 4)).toBe(false)
    expect(
      await f.store.admission(f.first).acquire({ ...f.device(f.first), routeKey: undefined })
    ).toBe('skipped')
  })

  it('accepts a stripped resend after partial recipient acceptance', async () => {
    const f = await setup()
    const { origin: _origin, occurrence: _occurrence, ...legacy } = f.alert
    expect(await f.store.accept(A, 'another-phone', legacy)).toBe('queued')
  })
})
