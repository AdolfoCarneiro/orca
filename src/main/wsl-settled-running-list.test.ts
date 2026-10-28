import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProcessResult } from '@orca/process-host/process-spec'

const mocks = vi.hoisted(() => ({ runProcess: vi.fn() }))
vi.mock('@orca/process-host', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runProcess: mocks.runProcess
}))

import { _resetWslCachesForTests } from './wsl'
import {
  _resetWslBackgroundDistroGateForTests,
  listSettledRunningWslDistros,
  noteWslDistroMayHaveStopped,
  WSL_STOP_SETTLE_MS
} from './wsl-background-distro-gate'

function runningList(...distros: string[]): ProcessResult {
  return {
    code: 0,
    signal: null,
    stdout: distros.map((distro) => `${distro}\n`).join(''),
    stderr: '',
    timedOut: false
  }
}

let originalPlatform: NodeJS.Platform

beforeEach(() => {
  originalPlatform = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  mocks.runProcess.mockReset().mockResolvedValue(runningList('Ubuntu', 'Debian'))
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
  _resetWslCachesForTests()
  _resetWslBackgroundDistroGateForTests()
  vi.useRealTimers()
})

describe('listSettledRunningWslDistros', () => {
  it('drops a distro the list still names inside its stop settle window (E9)', async () => {
    vi.useFakeTimers({ toFake: ['performance', 'Date', 'setTimeout'] })
    noteWslDistroMayHaveStopped('Ubuntu')

    await expect(listSettledRunningWslDistros()).resolves.toEqual(['Debian'])

    vi.advanceTimersByTime(WSL_STOP_SETTLE_MS + 1)
    _resetWslCachesForTests()
    await expect(listSettledRunningWslDistros()).resolves.toEqual(['Ubuntu', 'Debian'])
  })
})
