import { beforeEach, describe, expect, it, vi } from 'vitest'
import { bootAndroidDevice } from './android-avd-boot'
import type { AndroidSdkPaths } from './android-sdk-discovery'

const io = vi.hoisted(() => ({ launch: vi.fn() }))
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => {
    io.launch(...args)
    return { on: vi.fn(), unref: vi.fn() }
  }
}))

const sdk: AndroidSdkPaths = {
  sdkRoot: 'sdk',
  adb: 'adb',
  emulator: 'emulator',
  avdmanager: 'avdmanager'
}
type Device = { serial: string; name: string; booted: boolean }
const other: Device = { serial: 'emulator-5556', name: 'Other', booted: true }
const target: Device = { serial: 'emulator-5558', name: 'Wanted', booted: true }

function bootWithInventory(snapshots: Device[][], requested = 'Wanted') {
  let reads = 0
  let current: Device[] = []
  const runner = vi.fn(async (binary: string, args: readonly string[]) => {
    let stdout = ''
    if (binary === sdk.emulator && args[0] === '-list-avds') {
      stdout = 'Wanted\nOther\n'
    } else if (args[0] === 'devices') {
      current = snapshots[Math.min(reads++, snapshots.length - 1)]
      stdout = `List of devices attached\n${current.map((d) => `${d.serial}\tdevice`).join('\n')}`
    } else {
      const device = current.find((d) => d.serial === args[1])
      stdout = args[2] === 'emu' ? `${device?.name ?? ''}\nOK\n` : device?.booted ? '1' : '0'
    }
    return { code: 0, stdout, stderr: '' }
  })
  const sleep = vi.fn(async () => {})
  return {
    result: bootAndroidDevice(runner, sdk, requested, {
      bootTimeoutMs: 30,
      pollIntervalMs: 10,
      sleep
    }),
    runner,
    sleep
  }
}

beforeEach(() => io.launch.mockClear())

describe('Android AVD boot identity', () => {
  it('waits for the requested AVD when another emulator boots first', async () => {
    const { result, sleep } = bootWithInventory([
      [],
      [other],
      [other, { ...target, booted: false }],
      [other, target]
    ])
    expect(await result).toBe(target.serial)
    expect(sleep).toHaveBeenCalledTimes(2)
  })

  it('rejects the requested boot when only an unrelated new emulator appears', async () => {
    const { result } = bootWithInventory([[], [other]])
    await expect(result).rejects.toThrow('AVD "Wanted" did not finish booting in time.')
  })

  it('chooses the requested AVD when multiple new emulators are already booted', async () => {
    const { result } = bootWithInventory([[], [other, target]])
    expect(await result).toBe(target.serial)
  })

  it('reuses an already-running target by name without launching it again', async () => {
    const { result } = bootWithInventory([[other, target]])
    expect(await result).toBe(target.serial)
    expect(io.launch).not.toHaveBeenCalled()
  })

  it('reuses an already-running serial without querying AVD names', async () => {
    const { result, runner } = bootWithInventory([[target]], target.serial)
    expect(await result).toBe(target.serial)
    expect(runner).toHaveBeenCalledTimes(1)
    expect(io.launch).not.toHaveBeenCalled()
  })

  it('rejects an unknown AVD before launching a process', async () => {
    const { result } = bootWithInventory([[]], 'Missing')
    await expect(result).rejects.toThrow('not a running device or a known AVD')
    expect(io.launch).not.toHaveBeenCalled()
  })
})
