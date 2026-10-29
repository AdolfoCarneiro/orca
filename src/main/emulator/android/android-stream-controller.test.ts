import { afterEach, expect, it, vi } from 'vitest'
import { AndroidStreamController } from './android-stream-controller'
import { androidStreamSessionInfo, type StartAndroidStream } from './android-stream-session-starter'
import { scrcpyVideoRegistry } from '../scrcpy-video-registry'

const SERIAL = 'emulator-5554'

afterEach(() => scrcpyVideoRegistry.stop(SERIAL))

function fixture() {
  const jar = Promise.withResolvers<string>()
  const stream = Promise.withResolvers<Awaited<ReturnType<StartAndroidStream>>>()
  const entered = Promise.withResolvers<void>()
  const close = vi.fn(() => scrcpyVideoRegistry.stop(SERIAL))
  const startStreamSession = vi.fn(async () => {
    entered.resolve()
    return stream.promise
  })
  const controller = new AndroidStreamController({
    runner: async () => ({ stdout: '', stderr: '', code: 0 }),
    sdk: () => ({ sdkRoot: '/sdk', adb: '/sdk/adb', emulator: '/sdk/emulator', avdmanager: '' }),
    ensureJar: () => jar.promise,
    startStreamSession,
    maxSize: 1280
  })
  const finish = () => {
    scrcpyVideoRegistry.register(SERIAL, () => {})
    stream.resolve({ info: androidStreamSessionInfo(SERIAL), handle: { close } })
  }
  return { controller, jar, entered, close, finish, startStreamSession }
}

it('does not start a stream after stopping while its jar is pending', async () => {
  const s = fixture()
  s.startStreamSession.mockImplementationOnce(async () => {
    scrcpyVideoRegistry.register(SERIAL, () => {})
    return { info: androidStreamSessionInfo(SERIAL), handle: { close: s.close } }
  })
  const outcome = s.controller.start(SERIAL).catch((error: unknown) => error)
  s.controller.stop(SERIAL)
  s.jar.resolve('/cache/server.jar')

  expect(await outcome).toMatchObject({ code: 'emulator_no_active' })
  expect(s.startStreamSession).not.toHaveBeenCalled()
  expect(scrcpyVideoRegistry.has(SERIAL)).toBe(false)
})

it('closes a late stream handle and rejects the stopped start', async () => {
  const s = fixture()
  const outcome = s.controller.start(SERIAL).catch((error: unknown) => error)
  s.jar.resolve('/cache/server.jar')
  await s.entered.promise
  s.controller.stop(SERIAL)
  s.finish()

  expect(await outcome).toMatchObject({ code: 'emulator_no_active' })
  expect(s.close).toHaveBeenCalledOnce()
  expect(scrcpyVideoRegistry.has(SERIAL)).toBe(false)
})

it('waits for stopped startup teardown before starting its successor', async () => {
  const s = fixture()
  const first = s.controller.start(SERIAL).catch((error: unknown) => error)
  s.jar.resolve('/cache/server.jar')
  await s.entered.promise
  s.controller.stop(SERIAL)
  const successorClose = vi.fn(() => scrcpyVideoRegistry.stop(SERIAL))
  s.startStreamSession.mockImplementationOnce(async () => {
    expect(s.close).toHaveBeenCalledOnce()
    expect(scrcpyVideoRegistry.has(SERIAL)).toBe(false)
    scrcpyVideoRegistry.register(SERIAL, () => {})
    return { info: androidStreamSessionInfo(SERIAL), handle: { close: successorClose } }
  })
  const successor = s.controller.start(SERIAL)
  const duplicate = s.controller.start(SERIAL)
  s.finish()

  expect(await first).toMatchObject({ code: 'emulator_no_active' })
  expect(await successor).toEqual(androidStreamSessionInfo(SERIAL))
  expect(await duplicate).toEqual(androidStreamSessionInfo(SERIAL))
  expect(scrcpyVideoRegistry.has(SERIAL)).toBe(true)
  expect(s.startStreamSession).toHaveBeenCalledTimes(2)
  s.controller.stop(SERIAL)
  expect(successorClose).toHaveBeenCalledOnce()
})

it('can stop a successor that is still waiting for earlier startup', async () => {
  const s = fixture()
  const first = s.controller.start(SERIAL).catch((error: unknown) => error)
  s.jar.resolve('/cache/server.jar')
  await s.entered.promise
  s.controller.stop(SERIAL)
  const successor = s.controller.start(SERIAL).catch((error: unknown) => error)
  s.controller.stop(SERIAL)
  s.finish()

  expect(await first).toMatchObject({ code: 'emulator_no_active' })
  expect(await successor).toMatchObject({ code: 'emulator_no_active' })
  expect(s.startStreamSession).toHaveBeenCalledOnce()
  expect(s.close).toHaveBeenCalledOnce()
  expect(scrcpyVideoRegistry.has(SERIAL)).toBe(false)
})

it('deduplicates healthy starts and reuses a live stream until stop', async () => {
  const s = fixture()
  const first = s.controller.start(SERIAL)
  const second = s.controller.start(SERIAL)
  s.jar.resolve('/cache/server.jar')
  await s.entered.promise
  s.finish()

  expect(await first).toEqual(await second)
  expect(await s.controller.start(SERIAL)).toEqual(androidStreamSessionInfo(SERIAL))
  expect(s.startStreamSession).toHaveBeenCalledOnce()
  s.controller.stop(SERIAL)
  s.controller.stop(SERIAL)
  expect(s.close).toHaveBeenCalledOnce()
})

it('allows a failed start to retry', async () => {
  const s = fixture()
  const failure = new Error('owned startup failure')
  s.startStreamSession.mockRejectedValueOnce(failure)
  const first = s.controller.start(SERIAL).catch((error: unknown) => error)
  s.jar.resolve('/cache/server.jar')
  expect(await first).toBe(failure)

  const retry = s.controller.start(SERIAL)
  await s.entered.promise
  s.finish()
  expect(await retry).toEqual(androidStreamSessionInfo(SERIAL))
  expect(s.startStreamSession).toHaveBeenCalledTimes(2)
  s.controller.stop(SERIAL)
  expect(s.close).toHaveBeenCalledOnce()
})
