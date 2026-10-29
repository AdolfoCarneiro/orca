import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import type * as NodeFs from 'node:fs'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveCodexLaunchHome } from '../codex/codex-launch-home'
import { createSettings } from './runtime-home-settings-test-fixtures'
import {
  createCodexAccountRecord,
  createCodexAuthJson,
  createManagedAuth,
  createStore,
  getRuntimeCodexAuthPath,
  getRuntimeCodexHomePath,
  getSharedRuntimeAuthProvenancePath,
  getSystemCodexAuthPath,
  getSystemCodexHomePath,
  setRealHomeRoutableForTest,
  setupRuntimeHomeTest,
  teardownRuntimeHomeTest,
  testState,
  writePaneRegistry
} from './runtime-home-service-test-harness'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return { ...actual, readdirSync: vi.fn(actual.readdirSync) }
})

// Keep asserted config bytes independent of platform socket-path limits.
vi.mock('../codex/codex-daemon-socket-path-guard', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  applyCodexDaemonSocketGuard: (config: string) => config
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.userDataDir
  }
}))
beforeEach(() => installFakeAppEnvironment({ getPath: () => testState.userDataDir }))

vi.mock(import('node:os'), async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    homedir: () => testState.fakeHomeDir
  }
})

describe('CodexRuntimeHomeService', () => {
  beforeEach(() => {
    setupRuntimeHomeTest()
  })

  afterEach(() => {
    teardownRuntimeHomeTest()
  })

  it('routes host system default to the real home', async () => {
    const store = createStore(createSettings({ realHomeRoutable: true }))
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    expect(service.isHostSystemDefaultRealHomeSelected()).toBe(true)
    expect(service.prepareForCodexLaunch()).toBeNull()
    expect(service.getHostCodexHomePathsForSessionDiscovery()).toEqual([
      getRuntimeCodexHomePath(),
      getSystemCodexHomePath()
    ])
    const markerPath = join(
      testState.userDataDir,
      'codex-session-backfill',
      'backfill-complete.json'
    )
    mkdirSync(join(testState.userDataDir, 'codex-session-backfill'), { recursive: true })
    const perSpawnCustomHome = join(testState.fakeHomeDir, 'per-spawn-custom-codex-home')
    writeFileSync(markerPath, '{}\n', 'utf-8')
    expect(service.isHostSystemDefaultRealHomeSelected({ CODEX_HOME: perSpawnCustomHome })).toBe(
      false
    )
    expect(service.prepareForCodexLaunch(undefined, { CODEX_HOME: perSpawnCustomHome })).toBe(
      getSystemCodexHomePath()
    )
    expect(
      service.resolveHostCodexHomePathForLaunchReadOnly({ CODEX_HOME: perSpawnCustomHome })
    ).toBe(getSystemCodexHomePath())
    expect(existsSync(markerPath)).toBe(true)
    expect(
      service.beginHostSystemDefaultSessionMigrationLaunch(getRuntimeCodexHomePath(), {
        launchEnv: { CODEX_HOME: perSpawnCustomHome }
      })
    ).toBeNull()
    if (process.platform !== 'win32') {
      // Avoid ambient WSL bash: shell-startup home discovery is a POSIX-host contract.

      writeFileSync(
        join(testState.fakeHomeDir, '.zshrc'),
        'export CODEX_HOME="$HOME/shell-custom-codex-home"\n',
        'utf-8'
      )
      const shellLaunchEnv = { HOME: testState.fakeHomeDir, SHELL: '/bin/zsh' }
      expect(service.isHostSystemDefaultRealHomeSelected(shellLaunchEnv)).toBe(false)
      expect(service.prepareForCodexLaunch(undefined, shellLaunchEnv)).toBe(
        getSystemCodexHomePath()
      )
      expect(service.resolveHostCodexHomePathForLaunchReadOnly(shellLaunchEnv)).toBe(
        getSystemCodexHomePath()
      )
    }
    const previousCodexHome = process.env.CODEX_HOME
    const previousOrcaCodexHome = process.env.ORCA_CODEX_HOME
    process.env.CODEX_HOME = getRuntimeCodexHomePath()
    process.env.ORCA_CODEX_HOME = getRuntimeCodexHomePath()
    try {
      // Pin the path so nested Orca cannot poll an inherited managed CODEX_HOME.

      expect(service.prepareForRateLimitFetch()).toEqual({
        kind: 'ready',
        codexHomePath: getSystemCodexHomePath()
      })
      process.env.CODEX_HOME = getSystemCodexHomePath()
      delete process.env.ORCA_CODEX_HOME
      expect(service.isHostSystemDefaultRealHomeSelected()).toBe(true)
      process.env.CODEX_HOME = join(testState.fakeHomeDir, 'user-owned-codex-home')
      expect(service.isHostSystemDefaultRealHomeSelected()).toBe(false)
      expect(service.prepareForRateLimitFetch()).toEqual({
        kind: 'ready',
        codexHomePath: getRuntimeCodexHomePath()
      })
    } finally {
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME
      } else {
        process.env.CODEX_HOME = previousCodexHome
      }
      if (previousOrcaCodexHome === undefined) {
        delete process.env.ORCA_CODEX_HOME
      } else {
        process.env.ORCA_CODEX_HOME = previousOrcaCodexHome
      }
    }
  })

  it('seeds shared auth for a pane-local custom home on the real-home lane', async () => {
    const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'system-token')
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const store = createStore(createSettings({ realHomeRoutable: true }))
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)
    const customHome = join(testState.fakeHomeDir, 'pane-custom-codex-home')

    service.syncForCurrentSelection(undefined, { CODEX_HOME: customHome })
    expect(readFileSync(getRuntimeCodexAuthPath(), 'utf-8')).toBe(systemAuth)
  })

  it('skips retired-home reconciliation when no retained host pane can use it', async () => {
    const syncLegacySharedCodexConfigForRetainedPanes = vi.fn()
    vi.doMock('./legacy-shared-config-compatibility', () => ({
      syncLegacySharedCodexConfigForRetainedPanes
    }))
    const retainedAuth = createCodexAuthJson('system@example.com', 'acct-system', 'retained')
    const currentAuth = createCodexAuthJson('system@example.com', 'acct-system', 'current')
    const retainedConfig = 'model = "retained"\n'
    writePaneRegistry({
      'real-home-pane': {
        selectionKey: 'host',
        accountId: null,
        homeRoute: 'real-home'
      }
    })
    writeFileSync(getRuntimeCodexAuthPath(), retainedAuth, 'utf-8')
    writeFileSync(join(getRuntimeCodexHomePath(), 'config.toml'), retainedConfig, 'utf-8')
    writeFileSync(getSystemCodexAuthPath(), currentAuth, 'utf-8')
    writeFileSync(join(getSystemCodexHomePath(), 'config.toml'), 'model = "current"\n', 'utf-8')
    writeFileSync(
      getSharedRuntimeAuthProvenancePath(),
      `${JSON.stringify({ owner: 'system-default', authJson: retainedAuth })}\n`,
      'utf-8'
    )
    const store = createStore(createSettings({ realHomeRoutable: true }))
    try {
      const { CodexRuntimeHomeService } = await import('./runtime-home-service')
      const service = new CodexRuntimeHomeService(store as never)

      service.reconcileLegacySharedHomeForRetainedPanes()
      expect(service.prepareForCodexLaunch()).toBeNull()
      expect(service.prepareForRateLimitFetch()).toEqual({
        kind: 'ready',
        codexHomePath: getSystemCodexHomePath()
      })

      expect(syncLegacySharedCodexConfigForRetainedPanes).not.toHaveBeenCalled()
      expect(readFileSync(getRuntimeCodexAuthPath(), 'utf-8')).toBe(retainedAuth)
      expect(readFileSync(join(getRuntimeCodexHomePath(), 'config.toml'), 'utf-8')).toBe(
        retainedConfig
      )
    } finally {
      vi.doUnmock('./legacy-shared-config-compatibility')
    }
  })

  it('resolves only Orca-owned homes used by live retained host shells', async () => {
    const accountHome = createManagedAuth(
      testState.userDataDir,
      'account-1',
      createCodexAuthJson('managed@example.com', 'acct-managed', 'managed')
    )
    const unownedHome = join(testState.fakeHomeDir, 'unowned-codex-home')
    mkdirSync(unownedHome, { recursive: true })
    writeFileSync(join(unownedHome, '.orca-managed-home'), 'account-2\n', 'utf-8')
    writePaneRegistry({
      'shared-pane': { selectionKey: 'host', accountId: null, homeRoute: 'shared-home' },
      'account-pane': { selectionKey: 'host', accountId: 'account-1', homeRoute: 'account-home' },
      'unowned-pane': { selectionKey: 'host', accountId: 'account-2', homeRoute: 'account-home' },
      'real-pane': { selectionKey: 'host', accountId: null, homeRoute: 'real-home' },
      'wsl-pane': { selectionKey: 'wsl:Ubuntu', accountId: null, homeRoute: 'wsl-home' }
    })
    const settings = createSettings({
      codexManagedAccounts: [
        createCodexAccountRecord('account-1', 'managed@example.com', 'acct-managed', accountHome),
        createCodexAccountRecord('account-2', 'other@example.com', 'acct-other', unownedHome)
      ]
    })
    const store = createStore(settings)
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    expect(
      service.getRetainedHostCodexHookHomePaths([
        'shared-pane',
        'account-pane',
        'unowned-pane',
        'real-pane',
        'wsl-pane',
        'unknown-pane'
      ])
    ).toEqual([getRuntimeCodexHomePath(), accountHome])
  })

  it.each([8, 80])(
    'inventories a retained actor family once for %i panes per operation',
    async (count) => {
      const login = createManagedAuth(testState.userDataDir, 'account-1', '{"account":"one"}')
      const actors = Array.from({ length: count }, () =>
        resolveCodexLaunchHome({
          selectedAccount: { homePath: login, id: 'account-1' },
          conversationHome: getSystemCodexHomePath()
        })!
      )
      const ids = Array.from({ length: count }, (_, i) => `pane-${i}`)
      writePaneRegistry(
        Object.fromEntries(
          ids.map((id) => [
            id,
            {
              selectionKey: 'host',
              accountId: 'account-1',
              homeRoute: 'account-home'
            }
          ])
        )
      )
      const settings = createSettings({
        codexManagedAccounts: [
          createCodexAccountRecord('account-1', 'one@example.test', 'one', login)
        ]
      })
      const { CodexRuntimeHomeService } = await import('./runtime-home-service')
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture implements the service's settings surface.
      const service = new CodexRuntimeHomeService(createStore(settings) as never)
      const familyRoot = join(dirname(login), 'overlays')
      for (let pass = 0; pass < 2; pass++) {
        vi.mocked(readdirSync).mockClear()
        expect(
          service.getRetainedHostCodexHookHomePaths(ids).map((home) => realpathSync(home))
        ).toEqual(expect.arrayContaining(actors))
        expect(
          vi.mocked(readdirSync).mock.calls.filter(([path]) => String(path) === familyRoot)
        ).toHaveLength(1)
      }
      settings.codexManagedAccounts = []
      expect(service.getRetainedHostCodexHookHomePaths(ids)).toEqual([])
    }
  )

  it.each([8, 80])(
    'processes the actual outer History/resume inventory linearly at %i actors',
    async (count) => {
      const login = createManagedAuth(testState.userDataDir, 'account-1', '{"account":"one"}')
      const actors = Array.from({ length: count }, () =>
        resolveCodexLaunchHome({
          selectedAccount: { homePath: login, id: 'account-1' },
          conversationHome: getSystemCodexHomePath()
        })!
      )
      const settings = createSettings({
        codexManagedAccounts: [
          createCodexAccountRecord('account-1', 'one@example.test', 'one', login)
        ],
        activeCodexManagedAccountId: 'account-1',
        activeCodexManagedAccountIdsByRuntime: { host: 'account-1', wsl: {} }
      })
      const { CodexRuntimeHomeService } = await import('./runtime-home-service')
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture implements the settings store surface.
      const service = new CodexRuntimeHomeService(createStore(settings) as never)
      const NativeSet = globalThis.Set
      const counts: number[] = []
      class CountOuterSet<T> extends NativeSet<T> {
        constructor(values?: Iterable<T> | null) {
          super(values)
          if (Array.isArray(values) && values[0] === getRuntimeCodexHomePath()) {
            counts.push(values.length)
          }
        }
      }
      try {
        vi.stubGlobal('Set', CountOuterSet)
        for (let pass = 0; pass < 2; pass++) {
          const homes = service.getHostCodexHomePathsForSessionDiscovery()
          expect(homes[0]).toBe(getRuntimeCodexHomePath())
          expect(homes).toContain(login)
          expect(homes).toContain(getSystemCodexHomePath())
          for (const actor of actors) {
            expect(homes.map((home) => home.replace('/private/var/', '/var/'))).toContain(
              actor.replace('/private/var/', '/var/')
            )
          }
        }
        // No custom configured source in this fixture: mirror + H + N actors + X + System + H.
        expect(counts).toEqual([count + 5, count + 5])
      } finally {
        vi.unstubAllGlobals()
      }
    }
  )

  it('keeps pre-rollout shared-home panes authenticated on the real-home lane', async () => {
    const oldSystemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'old-system')
    const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'system')
    const systemConfig = [
      'model_provider = "codex-lb"',
      '',
      '[model_providers.codex-lb]',
      'base_url = "https://codex-lb.example.test/v1"',
      'requires_openai_auth = true',
      ''
    ].join('\n')
    writeFileSync(getSystemCodexAuthPath(), oldSystemAuth, 'utf-8')
    const store = createStore(createSettings({ realHomeRoutable: false }))
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    new CodexRuntimeHomeService(store as never)
    expect(readFileSync(getRuntimeCodexAuthPath(), 'utf-8')).toBe(oldSystemAuth)

    setRealHomeRoutableForTest(true)
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    writeFileSync(join(getSystemCodexHomePath(), 'config.toml'), systemConfig, 'utf-8')
    writeFileSync(
      join(getRuntimeCodexHomePath(), 'config.toml'),
      'model_provider = "stale-provider"\n',
      'utf-8'
    )

    const service = new CodexRuntimeHomeService(store as never)

    expect(readFileSync(getRuntimeCodexAuthPath(), 'utf-8')).toBe(oldSystemAuth)
    expect(readFileSync(join(getRuntimeCodexHomePath(), 'config.toml'), 'utf-8')).toContain(
      'stale-provider'
    )
    service.reconcileLegacySharedHomeForRetainedPanes()
    expect(readFileSync(getRuntimeCodexAuthPath(), 'utf-8')).toBe(systemAuth)
    expect(readFileSync(join(getRuntimeCodexHomePath(), 'config.toml'), 'utf-8')).toBe(systemConfig)
    expect(service.prepareForCodexLaunch()).toBeNull()
  })

  it('preserves retained managed auth across a real-home main-process restart', async () => {
    const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'system')
    const managedAuth = createCodexAuthJson('managed@example.com', 'acct-managed', 'managed')
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const store = createStore(createSettings({ realHomeRoutable: false }))
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    new CodexRuntimeHomeService(store as never)
    writeFileSync(getRuntimeCodexAuthPath(), managedAuth, 'utf-8')

    setRealHomeRoutableForTest(true)
    const restartedService = new CodexRuntimeHomeService(store as never)

    expect(restartedService.prepareForCodexLaunch()).toBeNull()
    expect(readFileSync(getRuntimeCodexAuthPath(), 'utf-8')).toBe(managedAuth)
    expect(readFileSync(getSystemCodexAuthPath(), 'utf-8')).toBe(systemAuth)
  })
})
