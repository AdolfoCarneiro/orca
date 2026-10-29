import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bootAndroidDevice } from './android-avd-boot'
import type { AndroidCommandRunner } from './android-command-runner'
import type { AndroidSdkPaths } from './android-sdk-discovery'

vi.mock('node:child_process', () => ({ spawn: () => ({ on: vi.fn(), unref: vi.fn() }) }))
const sdk: AndroidSdkPaths = {
  sdkRoot: 'sdk',
  adb: 'adb',
  emulator: 'emulator',
  avdmanager: 'avdmanager'
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
})
afterEach(() => vi.useRealTimers())

function scenario(
  options: { censusMs?: number; lookupMs?: number; bootMs?: number; booted?: boolean } = {}
) {
  let census = 0
  const polling: { args: readonly string[]; timeoutMs?: number }[] = []
  const runner: AndroidCommandRunner = vi.fn(async (binary, args, commandOptions) => {
    let stdout = ''
    if (binary === sdk.emulator) {
      stdout = 'Wanted\n'
    } else if (args[0] === 'devices') {
      census += 1
      if (census > 1) {
        polling.push({ args, timeoutMs: commandOptions?.timeoutMs })
        vi.advanceTimersByTime(options.censusMs ?? 0)
        stdout = 'List of devices attached\nemulator-5558\tdevice\n'
      } else {
        stdout = 'List of devices attached\n'
      }
    } else {
      polling.push({ args, timeoutMs: commandOptions?.timeoutMs })
      vi.advanceTimersByTime(args[2] === 'emu' ? (options.lookupMs ?? 0) : (options.bootMs ?? 0))
      stdout = args[2] === 'emu' ? 'Wanted\nOK\n' : options.booted ? '1' : '0'
    }
    return { code: 0, stdout, stderr: '' }
  })
  const sleep = vi.fn(async (ms: number) => {
    vi.advanceTimersByTime(ms)
  })
  return { runner, sleep, polling, census: () => census }
}

describe('Android boot elapsed deadline', () => {
  it('counts slow ADB work and does not start another poll after the budget expires', async () => {
    const s = scenario({ censusMs: 30 })
    await expect(
      bootAndroidDevice(s.runner, sdk, 'Wanted', {
        bootTimeoutMs: 30,
        pollIntervalMs: 10,
        sleep: s.sleep
      })
    ).rejects.toThrow('did not finish booting in time')
    expect(s.census()).toBe(2)
    expect(s.sleep).not.toHaveBeenCalled()
    expect(s.polling).toHaveLength(1)
  })

  it('passes the remaining budget to each ADB command and clips the last sleep', async () => {
    const s = scenario({ censusMs: 5, lookupMs: 5, bootMs: 5 })
    await expect(
      bootAndroidDevice(s.runner, sdk, 'Wanted', {
        bootTimeoutMs: 30,
        pollIntervalMs: 100,
        sleep: s.sleep
      })
    ).rejects.toThrow('did not finish booting in time')
    expect(s.polling.map((call) => call.timeoutMs)).toEqual([30, 25, 20])
    expect(s.sleep).toHaveBeenCalledExactlyOnceWith(15)
    expect(Date.now()).toBe(30)
  })

  it('does not accept a boot-completed result after its elapsed budget', async () => {
    const s = scenario({ bootMs: 31, booted: true })
    await expect(
      bootAndroidDevice(s.runner, sdk, 'Wanted', {
        bootTimeoutMs: 30,
        pollIntervalMs: 10,
        sleep: s.sleep
      })
    ).rejects.toThrow('did not finish booting in time')
  })

  it('keeps the existing per-command limit and accepts a timely boot', async () => {
    const s = scenario({ booted: true })
    expect(
      await bootAndroidDevice(s.runner, sdk, 'Wanted', {
        bootTimeoutMs: 180_000,
        pollIntervalMs: 2000,
        sleep: s.sleep
      })
    ).toBe('emulator-5558')
    expect(s.polling.every((call) => (call.timeoutMs ?? 60_000) <= 60_000)).toBe(true)
    expect(s.sleep).not.toHaveBeenCalled()
  })
})
