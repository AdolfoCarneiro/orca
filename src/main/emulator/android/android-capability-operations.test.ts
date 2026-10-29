import { describe, expect, it, vi } from 'vitest'
import type { AndroidCommandResult, AndroidCommandRunner } from './android-command-runner'
import type { AndroidSdkPaths } from './android-sdk-discovery'
import {
  dumpAndroidAccessibilityTree,
  installAndroidApk,
  launchAndroidApp
} from './android-capability-operations'

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

describe('launchAndroidApp', () => {
  it.each([
    { stdout: '', stderr: 'Error type 3\nError: Activity class {com.x/.Missing} does not exist.' },
    {
      stdout: '',
      stderr: 'Error: Activity not started, unable to resolve Intent { cmp=com.x/.Main }'
    },
    { stdout: '', stderr: 'Error: Activity not started, you do not have permission to access it.' },
    {
      stdout: 'Error: Activity class {com.x/.Missing} does not exist.',
      stderr: 'WARNING: diagnostic output'
    }
  ])('rejects a zero-exit activity launch failure: %j', async (diagnostic) => {
    const runner = vi.fn<AndroidCommandRunner>().mockResolvedValue({ ...diagnostic, code: 0 })

    await expect(launchAndroidApp(runner, SDK, 's', 'com.x', '.Missing')).rejects.toMatchObject({
      code: 'emulator_error',
      message: expect.stringContaining('Error:')
    })
  })

  it.each([
    '',
    'Warning: Activity not started, intent has been delivered to currently running top-most instance.',
    'Warning: Activity not started, its current task has been brought to the front'
  ])('accepts successful activity launches with diagnostics: %s', async (stderr) => {
    const runner = vi.fn<AndroidCommandRunner>().mockResolvedValue({
      code: 0,
      stdout: 'Starting: Intent { cmp=com.Error/.ErrorActivity }',
      stderr
    })

    await expect(
      launchAndroidApp(runner, SDK, 's', 'com.Error', '.ErrorActivity')
    ).resolves.toBeUndefined()
  })
})
