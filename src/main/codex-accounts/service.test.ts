import { describe, expect, it, vi, beforeEach } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createManagedHome,
  createRateLimits,
  createRuntimeHome,
  createSettings,
  createStore,
  registerCodexAccountsTestHomes,
  testState
} from './service-test-harness'

vi.mock('../codex/codex-daemon-socket-path-guard', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  applyCodexDaemonSocketGuard: (config: string) => config
}))
vi.mock('electron', () => ({ app: { getPath: () => testState.userDataDir } }))
beforeEach(() => installFakeAppEnvironment({ getPath: () => testState.userDataDir }))
vi.mock(import('node:os'), async (importOriginal) => ({
  ...(await importOriginal()),
  homedir: () => testState.fakeHomeDir
}))

async function fixture() {
  const systemHome = join(testState.fakeHomeDir, '.codex')
  const managedHomePath = createManagedHome(
    testState.userDataDir,
    'account-1',
    'approval_policy = "on-request"\n',
    '{"account":"managed"}\n'
  )
  const { resolveCodexLaunchHome } = await import('../codex/codex-launch-home')
  const overlay = resolveCodexLaunchHome({
    selectedAccount: { homePath: managedHomePath },
    systemHome,
    storeHome: systemHome
  })
  if (!overlay) {
    throw new Error('Expected an overlay')
  }
  const store = createStore(
    createSettings({
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'user@example.com',
          managedHomePath,
          providerAccountId: null,
          workspaceLabel: null,
          workspaceAccountId: null,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ],
      activeCodexManagedAccountId: 'account-1'
    })
  )
  const rateLimits = createRateLimits()
  const runtimeHome = createRuntimeHome()
  const { CodexAccountService } = await import('./service')
  const service = () =>
    new CodexAccountService(store as never, rateLimits as never, runtimeHome as never)
  return { systemHome, managedHomePath, overlay, rateLimits, runtimeHome, service }
}

describe('CodexAccountService overlay config sync', () => {
  registerCodexAccountsTestHomes()

  it('maintains the actor guard on startup without promoting or refreshing unused view config', async () => {
    const f = await fixture()
    writeFileSync(
      join(f.systemHome, 'config.toml'),
      ['model = "new-model"', 'model_instructions_file = "instructions.md"', ''].join('\n')
    )

    const before = readFileSync(join(f.overlay, 'config.toml'), 'utf8')
    f.service()

    const config = readFileSync(join(f.overlay, 'config.toml'), 'utf8')
    expect(config).toBe(before)
    expect(readFileSync(join(f.systemHome, 'config.toml'), 'utf8')).toContain('model = "new-model"')
    expect(config).toContain('sqlite_home = ')
    expect(config).toContain('cli_auth_credentials_store = "file"')
    expect(readFileSync(join(f.managedHomePath, 'config.toml'), 'utf8')).toBe(
      'approval_policy = "on-request"\n'
    )
    expect(readFileSync(join(f.managedHomePath, 'auth.json'), 'utf8')).toBe(
      '{"account":"managed"}\n'
    )
  })

  it('keeps detached actor auth and approvals on selection and seeds only the next fresh actor', async () => {
    const f = await fixture()
    const service = f.service()
    writeFileSync(join(f.overlay, 'config.toml'), 'approval_policy = "untrusted"\n')
    unlinkSync(join(f.overlay, 'auth.json'))
    writeFileSync(join(f.overlay, 'auth.json'), '{"account":"detached"}')
    writeFileSync(join(f.systemHome, 'config.toml'), 'model = "new-model"\n')

    await service.selectAccount('account-1')

    const config = readFileSync(join(f.overlay, 'config.toml'), 'utf8')
    expect(config).not.toContain('model = "new-model"')
    expect(config).toContain('approval_policy = "untrusted"')
    expect(readFileSync(join(f.overlay, 'auth.json'), 'utf8')).toContain('detached')
    const { resolveCodexLaunchHome } = await import('../codex/codex-launch-home')
    const fresh = resolveCodexLaunchHome({
      selectedAccount: { homePath: f.managedHomePath },
      storeHome: f.systemHome,
      systemHome: f.systemHome
    })!
    expect(fresh).not.toBe(f.overlay)
    expect(readFileSync(join(fresh, 'config.toml'), 'utf8')).toContain('model = "new-model"')
    expect(readFileSync(join(fresh, 'auth.json'), 'utf8')).toContain('managed')
    expect(f.rateLimits.refreshForCodexAccountChange).toHaveBeenCalledTimes(1)
    expect(f.runtimeHome.syncForCurrentSelection).toHaveBeenCalledTimes(1)
  })

  it('keeps existing overlay config and starts when the canonical config is unreadable', async () => {
    const f = await fixture()
    const previous = readFileSync(join(f.overlay, 'config.toml'), 'utf8')
    const configPath = join(f.systemHome, 'config.toml')
    writeFileSync(configPath, '')
    unlinkSync(configPath)
    mkdirSync(configPath)
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(f.service).not.toThrow()
      expect(readFileSync(join(f.overlay, 'config.toml'), 'utf8')).toBe(previous)
      expect(warning).not.toHaveBeenCalled()
    } finally {
      warning.mockRestore()
    }
  })
})
