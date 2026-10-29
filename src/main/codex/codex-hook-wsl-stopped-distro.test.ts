import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WslCanonicalPathSettled } from './codex-wsl-hook-install-plan'

const mocks = vi.hoisted(() => ({
  blocked: vi.fn(async (): Promise<{ distro: string; state: string } | null> => null),
  grant: vi.fn(),
  upsert: vi.fn(),
  removeStale: vi.fn(),
  createPlan: vi.fn()
}))

vi.mock('../wsl/wsl-unc-access-gate', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  blockedWslDistroForPath: mocks.blocked
}))
vi.mock('./codex-hook-trust-grant', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  grantManagedCodexHookTrust: mocks.grant
}))
vi.mock('./config-toml-trust', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  upsertHookTrustEntries: mocks.upsert
}))
vi.mock('./codex-hook-trust-cleanup', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, removeStaleWslRuntimeManagedHookTrustEntries: mocks.removeStale }
})
vi.mock('./codex-wsl-hook-install-plan', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createCodexWslRuntimeHookInstallPlan: mocks.createPlan
}))

import { installManagedHooksIntoWslRuntime } from './codex-hook-wsl-runtime'
import { CodexHookService } from './codex-hook-service-implementation'

const STOPPED = { distro: 'Ubuntu', state: 'stopped' }
let root: string

function plan() {
  const linuxHome = '/home/alice/.local/share/orca/codex-runtime-home/home'
  return {
    configPath: join(root, 'hooks.json'),
    tomlPath: join(root, 'config.toml'),
    scriptPath: join(root, '.orca', 'agent-hooks', 'codex-hook.sh'),
    commandScriptPath: `${linuxHome}/.orca/agent-hooks/codex-hook.sh`,
    trustConfigPath: `${linuxHome}/hooks.json`,
    wslDistro: 'Ubuntu',
    linuxRuntimeHome: linuxHome
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-codex-wsl-stopped-'))
  vi.stubEnv('ORCA_USER_DATA_PATH', root)
  writeFileSync(join(root, 'hooks.json'), '{"hooks":{}}\n', 'utf-8')
  writeFileSync(join(root, 'config.toml'), '', 'utf-8')
  mocks.blocked.mockReset().mockResolvedValue(null)
  mocks.grant.mockReset().mockResolvedValue({ lane: 'fallback', reason: 'unavailable' })
  mocks.upsert.mockReset()
  mocks.removeStale.mockReset()
  mocks.createPlan.mockReset()
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

// A stopped distro's `\\wsl.localhost` files would start it (E9): background installs skip instead.
describe('Codex WSL hook install on a stopped distro', () => {
  it('touches no file of a distro that is stopped when its turn comes', async () => {
    mocks.blocked.mockResolvedValue(STOPPED)
    await expect(installManagedHooksIntoWslRuntime(plan())).resolves.toBeNull()
    expect(mocks.blocked).toHaveBeenCalledWith('', 'Ubuntu')
    expect(readFileSync(join(root, 'hooks.json'), 'utf-8')).toBe('{"hooks":{}}\n')
    expect(existsSync(plan().scriptPath)).toBe(false)
    expect(mocks.grant).not.toHaveBeenCalled()
  })

  it('skips the fallback trust write when the distro stopped during the hash wait', async () => {
    mocks.grant.mockImplementation(async () => {
      mocks.blocked.mockResolvedValue(STOPPED)
      return { lane: 'fallback', reason: 'unavailable' }
    })
    await expect(installManagedHooksIntoWslRuntime(plan())).resolves.toBeNull()
    expect(mocks.upsert).not.toHaveBeenCalled()
  })

  it('still writes the fallback trust while the distro runs', async () => {
    await expect(installManagedHooksIntoWslRuntime(plan())).resolves.toMatchObject({
      state: 'installed'
    })
    expect(mocks.upsert).toHaveBeenCalledOnce()
  })

  it('does not revoke trust on a stopped distro when the canonical probe settles later', async () => {
    let settled: WslCanonicalPathSettled | undefined
    mocks.createPlan.mockImplementation(
      (
        _home: string,
        _target: unknown,
        _canonicalize: unknown,
        onSettled?: WslCanonicalPathSettled
      ) => {
        settled ??= onSettled
        return plan()
      }
    )
    mocks.blocked.mockResolvedValue(STOPPED)
    const service = new CodexHookService()
    await service.installForRuntimeHome(root, { runtime: 'wsl', wslDistro: 'Ubuntu' })
    // The primary install skipped, so a "missing" probe would otherwise revoke over UNC.
    settled?.({ status: 'missing' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(settled).toBeDefined()
    expect(mocks.removeStale).not.toHaveBeenCalled()
  })
})
