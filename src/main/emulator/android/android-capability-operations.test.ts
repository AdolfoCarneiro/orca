import { describe, expect, it, vi } from 'vitest'
import type { AndroidCommandResult, AndroidCommandRunner } from './android-command-runner'
import type { AndroidSdkPaths } from './android-sdk-discovery'
import { dumpAndroidAccessibilityTree, installAndroidApk } from './android-capability-operations'

const SDK: AndroidSdkPaths = {
  sdkRoot: '/sdk',
  adb: '/sdk/adb',
  emulator: '/sdk/emulator',
  avdmanager: '/sdk/avdmanager'
}

const ok = (stdout: string): AndroidCommandResult => ({ stdout, stderr: '', code: 0 })

function runnerReturning(map: Record<string, AndroidCommandResult>): AndroidCommandRunner {
  return (async (_binary: string, args: readonly string[]) =>
    map[args.join(' ')] ?? ok('')) as unknown as AndroidCommandRunner
}

describe('installAndroidApk', () => {
  it('installs and throws on a Failure stdout even with exit 0', async () => {
    const good = vi.fn(runnerReturning({ '-s s install /a.apk': ok('Success') }))
    await installAndroidApk(good as unknown as AndroidCommandRunner, SDK, 's', '/a.apk')
    expect(good).toHaveBeenCalledWith(SDK.adb, ['-s', 's', 'install', '/a.apk'])

    const bad = runnerReturning({ '-s s install /a.apk': ok('Failure [INSTALL_FAILED]') })
    await expect(installAndroidApk(bad, SDK, 's', '/a.apk')).rejects.toMatchObject({
      code: 'emulator_error'
    })
  })
})

describe('dumpAndroidAccessibilityTree', () => {
  it.each([
    { stdout: '', stderr: 'ERROR: could not get idle state.' },
    { stdout: '', stderr: 'ERROR: null root node returned by UiTestAutomationBridge.' },
    { stdout: 'ERROR: could not get idle state.', stderr: '' },
    { stdout: 'ERROR: could not get idle state.', stderr: 'WARNING: diagnostic output' }
  ])('rejects a zero-exit dump failure before reading stale XML: %j', async (diagnostic) => {
    const runner = vi.fn<AndroidCommandRunner>().mockResolvedValueOnce({ ...diagnostic, code: 0 })
    runner.mockResolvedValue(ok('<hierarchy><node text="Old screen"/></hierarchy>'))

    await expect(dumpAndroidAccessibilityTree(runner, SDK, 's')).rejects.toMatchObject({
      code: 'emulator_error',
      message: expect.stringContaining('ERROR:')
    })
    expect(runner).toHaveBeenCalledTimes(1)
  })

  it('reads a successful dump despite unrelated stderr warnings', async () => {
    const runner = vi.fn<AndroidCommandRunner>()
    runner.mockResolvedValueOnce({
      code: 0,
      stdout: 'UI hierchary dumped to: /sdcard/window_dump.xml',
      stderr: 'WARNING: diagnostic output'
    })
    runner.mockResolvedValueOnce(ok('<hierarchy><node text="Current screen"/></hierarchy>'))

    const tree = await dumpAndroidAccessibilityTree(runner, SDK, 's')
    expect(tree.children[0]).toMatchObject({ text: 'Current screen' })
    expect(runner).toHaveBeenCalledTimes(2)
  })
})
