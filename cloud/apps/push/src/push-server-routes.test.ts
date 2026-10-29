import nacl from 'tweetnacl'
import { afterEach, expect, it } from 'vitest'
import { pushRouteDeclarationContent } from '@orca-cloud/push-contract'
import { createPushServerHarness, APNS_TOKEN } from './push-server-harness.test-fixture.js'
import { createPushHostKeypair } from './host-challenge-answering.test-fixture.js'

let harness: Awaited<ReturnType<typeof createPushServerHarness>> | undefined
afterEach(async () => {
  await harness?.close()
})

it('validates signed current-device declarations before acknowledging ordered/idempotent versions', async () => {
  harness = await createPushServerHarness()
  const session = await harness.signIn(createPushHostKeypair(90))
  const key = nacl.sign.keyPair()
  const routeKey = Buffer.from(key.publicKey).toString('base64url')
  const sign = (version: number, hosts: string[]) => {
    const value = {
      v: 1 as const,
      platform: 'ios' as const,
      apnsEnvironment: 'production' as const,
      token: APNS_TOKEN,
      routeKey,
      version,
      hosts
    }
    return {
      ...value,
      signature: Buffer.from(
        nacl.sign.detached(Buffer.from(pushRouteDeclarationContent(value)), key.secretKey)
      ).toString('base64url')
    }
  }
  const body = sign(1, ['A'.repeat(16)])
  expect((await harness.post('/v1/routes', body)).status).toBe(400)
  expect(
    (
      await harness.post(
        '/v1/devices',
        {
          v: 1,
          deviceId: 'phone',
          platform: 'ios',
          apnsEnvironment: 'production',
          token: APNS_TOKEN,
          routeKey
        },
        session
      )
    ).status
  ).toBe(200)
  expect((await harness.post('/v1/routes', { ...body, v: 2 })).status).toBe(400)
  expect((await harness.post('/v1/routes', { ...body, signature: 'A'.repeat(86) })).status).toBe(
    400
  )
  expect(
    (
      await harness.post(
        '/v1/routes',
        sign(
          1,
          Array.from({ length: 101 }, (_, i) => String(i).padStart(16, 'A'))
        )
      )
    ).status
  ).toBe(400)
  expect((await harness.post('/v1/routes', body)).status).toBe(200)
  expect((await harness.post('/v1/routes', body)).status).toBe(200)
  expect((await harness.post('/v1/routes', sign(2, []))).status).toBe(200)
  expect((await harness.post('/v1/routes', body)).status).toBe(400)
  const [row] = await harness.database.query('SELECT hosts_json FROM push_route_declarations')
  if (!row) {
    throw new Error('Expected persisted route declaration')
  }
  expect(row.hosts_json).toBe('[]')
})

it('bounds route requests independently of registration and refuses an oversized body', async () => {
  harness = await createPushServerHarness()
  expect((await harness.post('/v1/routes', { filler: 'x'.repeat(16_384) })).status).toBe(413)
  harness.advanceClock(60_000)
  const key = nacl.sign.keyPair()
  const body = {
    v: 1 as const,
    platform: 'ios' as const,
    apnsEnvironment: 'production' as const,
    token: APNS_TOKEN,
    routeKey: Buffer.from(key.publicKey).toString('base64url'),
    version: 1,
    hosts: []
  }
  const signed = {
    ...body,
    signature: Buffer.from(
      nacl.sign.detached(Buffer.from(pushRouteDeclarationContent(body)), key.secretKey)
    ).toString('base64url')
  }
  for (let i = 0; i < 30; i++) expect((await harness.post('/v1/routes', signed)).status).toBe(400)
  expect((await harness.post('/v1/routes', signed)).status).toBe(429)
})
