import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { runProcess } from '@orca/process-host'
import { expect, it, vi } from 'vitest'
import {
  createOwnerBridge,
  integrationRows as rows,
  integrationDeadline as deadline
} from './push-owner-bridge.test-fixture'
import { desktopActors } from './push-owner-desktop.test-fixture'
import { httpResult, record, text } from '../../../shared/push-owner-integration.test-fixture'

it('keeps T2 through late/lost actual replies and recovers bounded source failures through real route/admission/provider settlement', async () => {
  const root = resolve('.')
  const scratch = mkdtempSync(join(tmpdir(), 'pr35901-owner-'))
  const bridge = createOwnerBridge()
  const base = await bridge.start()
  const abort = new AbortController()
  const closed = new Set<string>()
  let clock = 1_700_000_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => clock)
  const heldRoute = Promise.withResolvers<void>()
  const heldA = Promise.withResolvers<void>()
  const droppedA = Promise.withResolvers<void>()
  const refusalResponse = Promise.withResolvers<void>()
  const registrationCommit = Promise.withResolvers<void>()
  let refusalRace = false
  let aFirst = true
  let t1RouteHeld = false
  let accepted = 0
  let routeAttempts = 0
  const T1 = 'a'.repeat(64)
  const T2 = 'b'.repeat(64)
  const cloud = (op: string, data: Record<string, unknown> = {}) =>
    deadline(bridge.call('cloud', op, data), `cloud ${op}`)
  const mobile = (op: string, data: Record<string, unknown> = {}) =>
    deadline(bridge.call('mobile', op, data), `mobile ${op}`)
  const gateway = async (value: Record<string, unknown>) => {
    if (text(value.url).endsWith('/v1/routes')) {
      routeAttempts++
    }
    const result = await cloud('http', value)
    const response = httpResult(result)
    const url = text(value.url)
    if (url.endsWith('/v1/routes') && response.ok) {
      const declaration = record(JSON.parse(text(value.body)))
      if (declaration.token === T1 && !t1RouteHeld) {
        t1RouteHeld = true
        bridge.event('T1 route committed')
        await heldRoute.promise
      } else {
        bridge.event(`accepted:${++accepted}`, declaration)
      }
    }
    if (url.endsWith('/v1/routes') && refusalRace && response.status === 400) {
      bridge.event('real route refusal')
      await refusalResponse.promise
    }
    if (url.endsWith('/v1/send')) {
      expect(response.ok).toBe(true)
      const notification = record(record(JSON.parse(text(value.body))).notification)
      bridge.event(`sent:${text(value.host)}:${text(notification.occurrence)}`)
    }
    return result
  }
  const actors = desktopActors(scratch, async (host, url, init) =>
    httpResult(
      await gateway({
        host,
        url,
        method: init?.method ?? 'GET',
        headers: Object.fromEntries(new Headers(init?.headers)),
        ...(init?.body === undefined ? {} : { body: String(init.body) })
      })
    )
  )
  bridge.route(async (path, value) => {
    if (path === '/gateway') {
      return gateway(value)
    }
    if (path !== '/rpc') {
      throw new Error(`Unexpected bridge path ${path}`)
    }
    if (refusalRace && value.method === 'notifications.registerPush') {
      await registrationCommit.promise
    }
    const result = await actors.rpc(value)
    const params = record(value.params ?? {})
    if (value.method === 'notifications.registerPush') {
      expect(record(result).registered).toBe(true)
      const host = text(value.host)
      const token = text(params.token)
      bridge.event(`committed:${host}:${token}`)
      if (host === 'A' && token === T1 && aFirst) {
        aFirst = false
        await heldA.promise
      }
      if (host === 'A' && token === T2) {
        await droppedA.promise
      }
    }
    return result
  })
  const launches = ['cloud', 'mobile'].map(async (role) => {
    const cwd = role === 'cloud' ? join(root, 'cloud/apps/push') : join(root, 'mobile')
    const require = createRequire(join(cwd, 'package.json'))
    const cli = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs')
    return runProcess({
      program: process.execPath,
      args: [cli, 'run', '--config', join(root, `config/push-owner-${role}.vitest.config.mjs`)],
      cwd,
      env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1', ORCA_PUSH_OWNER_BRIDGE: base },
      signal: abort.signal,
      timeoutMs: 150_000,
      terminationBarrier: true,
      onChildTerminated: () => closed.add(role),
      stdio: 'inherit'
    })
  })
  const resultsPromise = Promise.allSettled(launches)
  let passed = false
  const advance = async (delta: number) => {
    clock += delta
    await cloud('advance', { delta })
    return mobile('advance', { delta })
  }
  const settle = async (label: string, expected: number) => {
    const occurrence = createHash('sha256').update(label).digest('base64url')
    actors.dispatch(occurrence)
    await deadline(
      Promise.all(['A', 'B'].map((host) => bridge.wait(`sent:${host}:${occurrence}`))),
      'actual desktop sends'
    )
    await cloud('flush')
    await advance(1000)
    await cloud('flush')
    const snapshot = record(await cloud('snapshot'))
    const providers = rows(snapshot.providers)
    expect(providers).toHaveLength(expected)
    const provider = providers.at(-1)
    if (!provider) {
      throw new Error('No actual final provider request')
    }
    expect(provider.path).toBe(`/3/device/${T2}`)
    expect(record(record(JSON.parse(text(provider.body))).orca)).toMatchObject({
      origin: actors.origin,
      occurrence
    })
    expect(rows(snapshot.claims).filter((claim) => claim.state === 'sent')).toHaveLength(expected)
    expect(rows(snapshot.pending)).toEqual([])
    if (!Array.isArray(snapshot.decisions)) {
      throw new Error('Missing actual admission observations')
    }
    expect(snapshot.decisions.filter((decision) => decision === 'admitted')).toHaveLength(expected)
    expect(snapshot.decisions.filter((decision) => decision === 'superseded')).toHaveLength(
      expected
    )
    expect(rows(snapshot.recipients)).toHaveLength(expected * 2)
    return snapshot
  }
  try {
    await deadline(
      Promise.all([bridge.ready('cloud'), bridge.ready('mobile')]),
      'actors ready',
      45_000
    )
    await mobile('start', { profiles: actors.profiles })
    await deadline(bridge.wait(`committed:B:${T1}`), 'B T1 registration')
    await advance(1000)
    await deadline(bridge.wait('T1 route committed'), 'real signed T1 route')
    await deadline(bridge.wait(`committed:A:${T1}`), 'delayed A T1 registration')
    await mobile('token', { token: T2 })
    await deadline(bridge.wait(`observed:B:${T2}`), 'B T2 real success consumed')
    await mobile('drain')
    heldA.resolve()
    await deadline(bridge.wait(`committed:A:${T2}`), 'A T2 committed with lost reply')
    await advance(5000)
    heldRoute.resolve()
    const declaration = record(
      await deadline(bridge.wait('accepted:1'), 'actual current T2 declaration')
    )
    expect(declaration.token).toBe(T2)
    expect(declaration.hosts).toHaveLength(2)
    const state = await settle('g4-current-owner', 1)
    expect(rows(state.devices)).toHaveLength(2)
    expect(
      rows(state.devices).every(
        (device) => device.token === T2 && device.route_key === declaration.routeKey
      )
    ).toBe(true)
    expect(
      rows(state.claims).every((claim) => claim.winner_route_key === declaration.routeKey)
    ).toBe(true)
    expect(actors.registered()).toHaveLength(2)
    droppedA.resolve()
    await actors.rpc({ host: 'A', method: 'notifications.unregisterPush' })
    await actors.rpc({ host: 'B', method: 'notifications.unregisterPush' })
    refusalRace = true
    const priorRefusal = accepted
    await mobile('foreground')
    await deadline(bridge.wait('real route refusal'), 'actual live-registration route refusal')
    registrationCommit.resolve()
    await deadline(bridge.wait('renewed:B'), 'current registration wake racing refusal')
    await mobile('drain')
    refusalResponse.resolve()
    await advance(1)
    await deadline(bridge.wait(`accepted:${priorRefusal + 1}`), 'real refusal wake accepted')
    refusalRace = false
    await settle('refusal-racing-registration', 2)
    await mobile('disconnect')
    for (const [index, kind] of [
      'catalog-read',
      'non-array',
      'version-read',
      'version-write',
      'catalog-race'
    ].entries()) {
      await mobile('fault', { kind })
      await mobile('background')
      await advance(10_000)
      const parked = record(await mobile('stats'))
      expect(parked.reads).toBe(3)
      const posts = accepted
      const attempted = routeAttempts
      await advance(60 * 60_000)
      expect(record(await mobile('stats')).reads).toBe(3)
      expect(accepted).toBe(posts)
      expect(routeAttempts).toBe(attempted)
      await mobile('repair')
      if (kind === 'catalog-race') {
        await mobile('release-failure')
      }
      const restored = record(
        await deadline(bridge.wait(`accepted:${posts + 1}`), `real repair ${kind}`)
      )
      expect(restored.token).toBe(T2)
      await settle(`g5-recovered-${index}`, index + 3)
    }
    const prior = accepted
    await mobile('restart')
    await deadline(bridge.wait(`accepted:${prior + 1}`), 'saved-state disconnected restart')
    passed = true
  } finally {
    heldA.resolve()
    heldRoute.resolve()
    droppedA.resolve()
    refusalResponse.resolve()
    registrationCommit.resolve()
    actors.stop()
    let cleanupError: unknown
    try {
      if (passed) {
        await mobile('stop')
        await cloud('stop')
      } else {
        abort.abort()
      }
    } catch (error) {
      cleanupError = error
      abort.abort()
    }
    const results = await resultsPromise
    try {
      await bridge.close()
    } catch (error) {
      cleanupError ??= error
    }
    vi.restoreAllMocks()
    if (closed.size === 2) {
      rmSync(scratch, { recursive: true, force: true })
    } else {
      throw new Error(`Owned companion closure unverified; retained ${scratch}`)
    }
    if (cleanupError) {
      throw cleanupError
    }
    for (const result of results) {
      if (result.status === 'rejected') {
        throw result.reason
      }
      expect(result.value.code).toBe(0)
    }
  }
}, 180_000)
