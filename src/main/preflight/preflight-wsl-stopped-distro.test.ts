import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProcessResult } from '@orca/process-host/process-spec'

const mocks = vi.hoisted(() => ({ runProcess: vi.fn(), runWslProcess: vi.fn() }))
vi.mock('@orca/process-host', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runProcess: mocks.runProcess
}))
vi.mock('../wsl/wsl-runner', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runWslProcess: mocks.runWslProcess
}))

import { _resetWslCachesForTests } from '../wsl'
import { _resetWslBackgroundDistroGateForTests } from '../wsl-background-distro-gate'
import { _resetPreflightCache, runPreflightCheck } from './agent-detection'
import { detectAgentsOnHost } from './workspace-agent-detection'

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
  mocks.runProcess.mockReset().mockResolvedValue(runningList())
  mocks.runWslProcess.mockReset()
  _resetPreflightCache()
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
  _resetWslCachesForTests()
  _resetWslBackgroundDistroGateForTests()
})

describe('background preflight never boots a stopped WSL distro (E9)', () => {
  it('refuses a focus-forced preflight of a stopped distro without running anything in it', async () => {
    await expect(runPreflightCheck(true, { wslDistro: 'Ubuntu' })).rejects.toThrow(
      "WSL distro 'Ubuntu' is not running"
    )
    expect(mocks.runWslProcess).not.toHaveBeenCalled()
  })

  it('refuses agent detection on mount for a stopped distro, never answering "no agents"', async () => {
    await expect(
      detectAgentsOnHost({ kind: 'local', context: { wslDistro: 'Ubuntu' } })
    ).rejects.toThrow("WSL distro 'Ubuntu' is not running")
    expect(mocks.runWslProcess).not.toHaveBeenCalled()
  })
})
