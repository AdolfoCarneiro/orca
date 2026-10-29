import '../daemon/mock-descendant-sweep'
import { createCodexAccountRecord } from './runtime-home-service-test-harness'
import type { PtyRuntimeControllerDeps } from '../ipc/pty/runtime/controller-deps'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import type * as NodeFs from 'node:fs'
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createSettings } from './runtime-home-settings-test-fixtures'
import {
  createCodexAuthJson,
  createManagedAuth,
  createStore,
  getRuntimeCodexAuthPath,
  getSystemCodexAuthPath,
  getSystemCodexHomePath,
  setupRuntimeHomeTest,
  teardownRuntimeHomeTest,
  testState
} from './runtime-home-service-test-harness'

const filesystemFailure = vi.hoisted(() => ({ path: '' }))
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof NodeFs>()
  return {
    ...actual,
    realpathSync: vi.fn((path: string) => {
      if (path === filesystemFailure.path) {
        throw Object.assign(new Error('fixture unreadable actor'), { code: 'EACCES' })
      }
      return actual.realpathSync(path)
    })
  }
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
    writeFileSync(join(getSystemCodexHomePath(), 'config.toml'), 'model = "test"\n')
  })

  afterEach(() => {
    teardownRuntimeHomeTest()
  })

  it('preserves selected identity when per-account auth disappears before launch', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'system')
    const account1Auth = createCodexAuthJson('one@example.com', 'acct-1', 'one', 1)
    const account1Refreshed = createCodexAuthJson('one@example.com', 'acct-1', 'one-refreshed', 2)
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const managedHomePath1 = createManagedAuth(testState.userDataDir, 'account-1', account1Auth)
    const wslManagedHomePath = createManagedAuth(
      testState.userDataDir,
      'wsl-account',
      createCodexAuthJson('wsl@example.com', 'acct-wsl', 'wsl')
    )
    const settings = createSettings({
      realHomeRoutable: true,
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'one@example.com',
          managedHomePath: managedHomePath1,
          providerAccountId: 'acct-1',
          workspaceLabel: null,
          workspaceAccountId: 'acct-1',
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        },
        {
          id: 'wsl-account',
          email: 'wsl@example.com',
          managedHomePath: wslManagedHomePath,
          managedHomeRuntime: 'wsl',
          wslDistro: 'Ubuntu',
          wslLinuxHomePath: '/home/alice/.local/share/orca/codex-accounts/wsl-account/home',
          createdAt: 2,
          updatedAt: 2,
          lastAuthenticatedAt: 2
        }
      ],
      activeCodexManagedAccountId: 'account-1',
      activeCodexManagedAccountIdsByRuntime: {
        host: 'account-1',
        wsl: { Ubuntu: 'wsl-account' }
      }
    })
    const store = createStore(settings)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    writeFileSync(runtimeAuthPath, account1Refreshed, 'utf-8')

    rmSync(join(managedHomePath1, 'auth.json'), { force: true })
    expect(service.prepareForCodexLaunch()).toBe(managedHomePath1)

    expect(existsSync(join(managedHomePath1, 'auth.json'))).toBe(false)
    expect(readFileSync(getSystemCodexAuthPath(), 'utf-8')).toBe(systemAuth)
    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe(account1Refreshed)
    expect(store.getSettings().activeCodexManagedAccountId).toBe('account-1')
    expect(store.updateSettings).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('clearing selection'))

    expect(service.isHostSystemDefaultRealHomeSelected()).toBe(false)
    expect(service.prepareForRateLimitFetch()).toEqual({
      kind: 'ready',
      codexHomePath: managedHomePath1
    })
    expect(service.prepareForCodexLaunch()).toBe(managedHomePath1)
    expect(existsSync(join(managedHomePath1, 'auth.json'))).toBe(false)

    writeFileSync(join(managedHomePath1, 'auth.json'), account1Auth, 'utf-8')
    expect(
      service.prepareForCodexLaunch(undefined, undefined, {
        unavailableManagedHomePath: managedHomePath1
      })
    ).toBe(managedHomePath1)
    expect(store.updateSettings).not.toHaveBeenCalled()

    rmSync(join(managedHomePath1, 'auth.json'), { force: true })

    const absenceObservedAt = Date.now()
    expect(
      service.prepareForCodexLaunch(undefined, undefined, {
        unavailableManagedHomePath: managedHomePath1
      })
    ).toBe(managedHomePath1)
    expect(store.updateSettings).not.toHaveBeenCalled()

    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => absenceObservedAt + 6_000)
    try {
      expect(
        service.prepareForCodexLaunch(undefined, undefined, {
          unavailableManagedHomePath: managedHomePath1
        })
      ).toBeNull()
    } finally {
      nowSpy.mockRestore()
    }
    expect(store.getSettings().activeCodexManagedAccountId).toBeNull()
    expect(store.getSettings().activeCodexManagedAccountIdsByRuntime).toEqual({
      host: null,
      wsl: { Ubuntu: 'wsl-account' }
    })
    expect(store.getSettings().codexManagedAccounts).toHaveLength(2)
    expect(store.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ activeCodexManagedAccountId: null })
    )
    expect(warnSpy).toHaveBeenCalledWith(
      '[codex-runtime-home] Active managed account credential remained unavailable, clearing selection'
    )
  })

  it('does not deselect the account when a transient unreadable auth.json heals', async () => {
    const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'system')
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const accountAuth = createCodexAuthJson('user@example.com', 'acct-user', 'managed')
    const managedHomePath = createManagedAuth(testState.userDataDir, 'account-1', accountAuth)
    const store = createStore(
      createSettings({
        realHomeRoutable: true,
        codexManagedAccounts: [
          {
            id: 'account-1',
            email: 'user@example.com',
            managedHomePath,
            providerAccountId: 'acct-user',
            workspaceLabel: null,
            workspaceAccountId: 'acct-user',
            createdAt: 1,
            updatedAt: 1,
            lastAuthenticatedAt: 1
          }
        ],
        activeCodexManagedAccountId: 'account-1',
        activeCodexManagedAccountIdsByRuntime: { host: 'account-1', wsl: {} }
      })
    )
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    writeFileSync(join(managedHomePath, 'auth.json'), '{"tokens":{"acc', 'utf-8')
    expect(
      service.prepareForCodexLaunch(undefined, undefined, {
        unavailableManagedHomePath: managedHomePath
      })
    ).toBe(managedHomePath)
    expect(store.getSettings().activeCodexManagedAccountId).toBe('account-1')
    expect(store.updateSettings).not.toHaveBeenCalled()

    writeFileSync(join(managedHomePath, 'auth.json'), accountAuth, 'utf-8')
    const healedAt = Date.now()
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => healedAt + 60_000)
    try {
      expect(
        service.prepareForCodexLaunch(undefined, undefined, {
          unavailableManagedHomePath: managedHomePath
        })
      ).toBe(managedHomePath)
    } finally {
      nowSpy.mockRestore()
    }
    expect(store.getSettings().activeCodexManagedAccountId).toBe('account-1')
    expect(store.updateSettings).not.toHaveBeenCalled()
    expect(warnSpy).not.toHaveBeenCalledWith(
      '[codex-runtime-home] Active managed account credential remained unavailable, clearing selection'
    )
  })

  it('ignores mismatched runtime auth when the active managed auth is missing', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'system')
    const managedAuth = createCodexAuthJson('user@example.com', 'acct-user', 'managed', 1)
    const mismatchedAuth = createCodexAuthJson('other@example.com', 'acct-other', 'other', 2)
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const managedHomePath = createManagedAuth(testState.userDataDir, 'account-1', managedAuth)
    const settings = createSettings({
      realHomeRoutable: true,
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'user@example.com',
          managedHomePath,
          providerAccountId: 'acct-user',
          workspaceLabel: null,
          workspaceAccountId: 'acct-user',
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ],
      activeCodexManagedAccountId: 'account-1',
      activeCodexManagedAccountIdsByRuntime: { host: 'account-1', wsl: {} }
    })
    const store = createStore(settings)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    writeFileSync(runtimeAuthPath, mismatchedAuth, 'utf-8')
    rmSync(join(managedHomePath, 'auth.json'), { force: true })
    expect(service.prepareForCodexLaunch()).toBe(managedHomePath)

    expect(existsSync(join(managedHomePath, 'auth.json'))).toBe(false)
    expect(readFileSync(getSystemCodexAuthPath(), 'utf-8')).toBe(systemAuth)
    expect(readFileSync(runtimeAuthPath, 'utf-8')).toBe(mismatchedAuth)
    expect(store.getSettings().activeCodexManagedAccountId).toBe('account-1')
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('clearing selection'))
  })

  it('ignores shared auth on an explicit managed-to-real-home deselect', async () => {
    const runtimeAuthPath = getRuntimeCodexAuthPath()
    const systemAuth = createCodexAuthJson('system@example.com', 'acct-system', 'system')
    const managedAuth = createCodexAuthJson('user@example.com', 'acct-user', 'managed', 1)
    const refreshedManagedAuth = createCodexAuthJson(
      'user@example.com',
      'acct-user',
      'refreshed',
      2
    )
    writeFileSync(getSystemCodexAuthPath(), systemAuth, 'utf-8')
    const managedHomePath = createManagedAuth(testState.userDataDir, 'account-1', managedAuth)
    const settings = createSettings({
      realHomeRoutable: true,
      codexManagedAccounts: [
        {
          id: 'account-1',
          email: 'user@example.com',
          managedHomePath,
          providerAccountId: 'acct-user',
          workspaceLabel: null,
          workspaceAccountId: 'acct-user',
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ],
      activeCodexManagedAccountId: 'account-1',
      activeCodexManagedAccountIdsByRuntime: { host: 'account-1', wsl: {} }
    })
    const store = createStore(settings)
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    writeFileSync(runtimeAuthPath, refreshedManagedAuth, 'utf-8')
    settings.activeCodexManagedAccountId = null
    settings.activeCodexManagedAccountIdsByRuntime = { host: null, wsl: {} }
    service.syncForCurrentSelection()
    expect(readFileSync(join(managedHomePath, 'auth.json'), 'utf-8')).toBe(managedAuth)

    const syncSpy = vi.spyOn(service, 'syncForCurrentSelection')
    expect(service.prepareForCodexLaunch()).toBeNull()
    expect(syncSpy).not.toHaveBeenCalled()
    expect(readFileSync(join(managedHomePath, 'auth.json'), 'utf-8')).toBe(managedAuth)
  })
})

// The provider is the external process boundary; selection, readiness, reservation and dispatch stay real.
describe('managed O recovery through actual runtime dispatch', () => {
  beforeEach(() => {
    setupRuntimeHomeTest()
    writeFileSync(join(getSystemCodexHomePath(), 'config.toml'), 'model = "fixture"\n')
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    teardownRuntimeHomeTest()
  })

  it.each(['durable absence', 'restored bytes'] as const)(
    '%s settles the actual reservation and delivers only after a legitimate wake',
    async (mode) => {
      const { spawnPtyFromRuntimeController } = await import('../ipc/pty/runtime/spawn')
      const { adoptStablePane } = await import('../ipc/pty/pane/adopt-stable')
      const { noCodexResumeLaunch } = await import('../ipc/pty/host-env/codex-resume')
      const { paneSpawnReservationsByOwnerKey, pendingRuntimePaneCreatesByOwnerKey } =
        await import('../ipc/pty/pane/spawn-reservation')
      const { setLocalPtyProvider } = await import('../ipc/pty/provider/registry')
      const { _internals: registryState, getCodexPaneAccount } =
        await import('../codex/codex-pane-account-registry')
      const readiness = await import('./managed-codex-auth-readiness')
      registryState.resetProcess()
      const receiptsBefore = JSON.parse(
        readFileSync(join(testState.userDataDir, 'codex-pane-accounts.json'), 'utf8')
      ).panes
      const auth = createCodexAuthJson('fixture@example.com', 'fixture-provider', 'fixture-refresh')
      const H = createManagedAuth(testState.userDataDir, 'account-1', auth)
      const store = createStore(
        createSettings({
          realHomeRoutable: true,
          agentStatusHooksEnabled: false,
          terminalScopeHistoryByWorktree: false,
          codexSessionSourceHome: { host: getSystemCodexHomePath() },
          codexManagedAccounts: [
            createCodexAccountRecord('account-1', 'fixture@example.com', 'fixture-provider', H)
          ],
          activeCodexManagedAccountId: 'account-1',
          activeCodexManagedAccountIdsByRuntime: { host: 'account-1', wsl: {} }
        })
      )
      const { CodexRuntimeHomeService } = await import('./runtime-home-service')
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: real service uses only the harness settings store ports.
      const service = new CodexRuntimeHomeService(store as never)
      const births: { home: string | undefined; id: string }[] = []
      const provider = {
        spawn: vi.fn(async (options: { sessionId?: string; env?: Record<string, string> }) => {
          const id = options.sessionId!
          births.push({ home: options.env?.CODEX_HOME, id })
          return { id, incarnationId: 'fixture-birth', pid: 700001 }
        }),
        listProcesses: async () => [],
        getForegroundProcess: async () => null,
        onData: () => () => {},
        onExit: () => () => {},
        write() {},
        resize() {},
        kill() {},
        async shutdown() {}
      }
      setLocalPtyProvider(provider)
      const publish = vi.fn(),
        committed = vi.fn()
      const inputs: string[] = []
      const deps: PtyRuntimeControllerDeps = {
        getSettings: () => store.getSettings(),
        getSelectedCodexHomePath: async (target, env, context) => {
          if (context?.unavailableManagedHomePath) {
            inputs.push(context.unavailableManagedHomePath)
          }
          return service.prepareForCodexLaunchAsync(target, env, context)
        },
        adoptStablePane: (args) => adoptStablePane(undefined, undefined, args),
        getLocalPtyStartupPromise: () => undefined,
        getLocalPtyProviderStartupPromise: () => undefined,
        prepareCodexResumeHome: () => null,
        resolveCodexResumeLaunch: async (command) => noCodexResumeLaunch(command),
        noCodexResumeLaunch,
        reconcileSharedRuntimeResumeHome: async (resume) => resume.codexHomePath,
        stripSequencedStartupResumeArgv: (env) => env,
        assertWorkspaceAcceptsNewPty: () => {},
        resolvePtySpawnStartupCwd: (_workspace, cwd) => cwd,
        requestSerializedBuffer: async () => null,
        shutdownProviderAndDetectExit: async () => false,
        rememberSyntheticKillExit() {},
        rememberRetiredRejectedPty() {},
        sendPtyExitToRenderer() {},
        sendPtySpawnedToRenderer: publish,
        finishPtyShutdown: () => undefined,
        trustedTerminalHandleEnv: new Set(),
        retiredRejectedPtyIds: new Map()
      }
      const wait = vi.spyOn(readiness, 'waitForManagedCodexAuthReady')
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
      const request = async () => {
        const before = wait.mock.calls.length
        const pending = spawnPtyFromRuntimeController(deps, {
          cols: 80,
          rows: 24,
          launchAgent: 'codex',
          shellOverride: '/bin/zsh',
          tabId: 'b1-proof',
          leafId: '11111111-1111-4111-8111-111111111111',
          env: {
            HOME: testState.fakeHomeDir,
            CLAUDE_CONFIG_DIR: join(testState.fakeHomeDir, '.claude')
          },
          onPtySpawnCommitted: committed
        }).then(
          (result) => ({ result, error: null }),
          (error) => ({ result: null, error: String(error.message) })
        )
        await vi.waitFor(() => expect(wait.mock.calls.length).toBeGreaterThan(before))
        expect(paneSpawnReservationsByOwnerKey.size).toBe(1)
        const reservation = [...paneSpawnReservationsByOwnerKey.values()][0]
        const settlement = reservation.promise.then(
          (result) => ({ id: result.id, error: null }),
          (error) => ({ id: null, error: String(error.message) })
        )
        return { pending, reservation, settlement }
      }
      if (mode === 'durable absence') {
        rmSync(join(H, 'auth.json'))
      } else {
        writeFileSync(
          join(H, 'auth.json'),
          '{"auth_mode":"chatgpt","tokens":{"access_token":"fixture-partial"}}'
        )
      }
      const first = await request()
      expect(births).toHaveLength(0)
      if (mode === 'durable absence') {
        await vi.advanceTimersByTimeAsync(3100)
        const failed = await first.pending
        expect(failed.error).toBe(
          'The selected Codex account credentials are temporarily unavailable. Try opening the terminal again.'
        )
        expect((await first.settlement).error).toBe(failed.error)
        expect(first.reservation.outcome).toBeUndefined()
        expect(paneSpawnReservationsByOwnerKey.size).toBe(0)
        expect(pendingRuntimePaneCreatesByOwnerKey.size).toBe(0)
        expect(inputs).toHaveLength(2)
        expect(inputs.every((home) => home.split(/[\\/]/).includes('overlays'))).toBe(true)
        expect(store.getSettings().activeCodexManagedAccountId).toBe('account-1')
        expect(births).toHaveLength(0)
        expect(publish).not.toHaveBeenCalled()
        expect(committed).not.toHaveBeenCalled()
        expect(
          existsSync(join(testState.userDataDir, 'codex-pane-accounts.json'))
            ? JSON.parse(
                readFileSync(join(testState.userDataDir, 'codex-pane-accounts.json'), 'utf8')
              ).panes
            : {}
        ).toEqual(receiptsBefore)
        await vi.advanceTimersByTimeAsync(6000)
        expect(store.getSettings().activeCodexManagedAccountId).toBe('account-1')
        const later = await request()
        await vi.advanceTimersByTimeAsync(3100)
        const delivered = await later.pending
        expect(delivered.error).toBeNull()
        expect(store.getSettings().activeCodexManagedAccountId).toBeNull()
        expect(later.reservation.outcome?.kind).toBe('committed')
        expect((await later.settlement).id).toBe(delivered.result!.id)
        expect(getCodexPaneAccount(delivered.result!.id)).toMatchObject({
          accountId: null,
          homeRoute: 'real-home'
        })
      } else {
        await vi.advanceTimersByTimeAsync(50)
        expect(births).toHaveLength(0)
        writeFileSync(join(H, 'auth.json'), auth)
        await vi.advanceTimersByTimeAsync(25)
        const delivered = await first.pending
        expect(delivered.error).toBeNull()
        expect(inputs).toEqual([])
        expect(store.getSettings().activeCodexManagedAccountId).toBe('account-1')
        expect(first.reservation.outcome?.kind).toBe('committed')
        expect((await first.settlement).id).toBe(delivered.result!.id)
        expect(births[0].home?.split(/[\\/]/)).toContain('overlays')
        expect(getCodexPaneAccount(delivered.result!.id)).toMatchObject({
          accountId: 'account-1',
          homeRoute: 'account-home'
        })
      }
      expect(births).toHaveLength(1)
      expect(publish).toHaveBeenCalledOnce()
      expect(committed).toHaveBeenCalledOnce()
      expect(paneSpawnReservationsByOwnerKey.size).toBe(0)
      expect(pendingRuntimePaneCreatesByOwnerKey.size).toBe(0)
      registryState.resetProcess()
    }
  )
})

describe('managed recovery canonical role and indeterminate IO', () => {
  beforeEach(() => {
    setupRuntimeHomeTest()
    filesystemFailure.path = ''
  })
  afterEach(() => {
    filesystemFailure.path = ''
    vi.useRealTimers()
    teardownRuntimeHomeTest()
  })
  it.each([false, true])(
    'compares both alias directions only after ownership (saved alias=%s)',
    async (savedAlias) => {
      const auth = createCodexAuthJson('fixture@example.com', 'fixture', 'fixture')
      const H = createManagedAuth(testState.userDataDir, 'account-1', auth)
      // The trusted resolver requires the actual account-root structure; /var and /private/var are filesystem aliases of that same structure.
      const canonical = realpathSync(H)
      const lexical = H
      const account = createCodexAccountRecord(
        'account-1',
        'fixture@example.com',
        'fixture',
        savedAlias ? lexical : canonical
      )
      const store = createStore(
        createSettings({
          realHomeRoutable: true,
          codexManagedAccounts: [account],
          activeCodexManagedAccountId: 'account-1',
          activeCodexManagedAccountIdsByRuntime: { host: 'account-1', wsl: {} }
        })
      )
      const { CodexRuntimeHomeService } = await import('./runtime-home-service')
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the settings store ports are used.
      const service = new CodexRuntimeHomeService(store as never)
      rmSync(join(H, 'auth.json'))
      vi.useFakeTimers({ toFake: ['Date'] })
      await service.prepareForCodexLaunchAsync(undefined, undefined, {
        unavailableManagedHomePath: savedAlias ? canonical : lexical
      })
      expect(store.getSettings().activeCodexManagedAccountId).toBe('account-1')
      vi.setSystemTime(Date.now() + 6000)
      await service.prepareForCodexLaunchAsync(undefined, undefined, {
        unavailableManagedHomePath: savedAlias ? canonical : lexical
      })
      expect(store.getSettings().activeCodexManagedAccountId).toBeNull()
    }
  )
  it('indeterminate internal O projection preserves selection and later actual IO recovery progresses', async () => {
    const H = createManagedAuth(
      testState.userDataDir,
      'account-1',
      createCodexAuthJson('fixture@example.com', 'fixture', 'fixture')
    )
    const store = createStore(
      createSettings({
        realHomeRoutable: true,
        codexSessionSourceHome: { host: getSystemCodexHomePath() },
        codexManagedAccounts: [
          createCodexAccountRecord('account-1', 'fixture@example.com', 'fixture', H)
        ],
        activeCodexManagedAccountId: 'account-1',
        activeCodexManagedAccountIdsByRuntime: { host: 'account-1', wsl: {} }
      })
    )
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the settings store ports are used.
    const service = new CodexRuntimeHomeService(store as never)
    const O = (await service.prepareForCodexLaunchAsync())!
    filesystemFailure.path = O
    await expect(
      service.prepareForCodexLaunchAsync(undefined, undefined, { unavailableManagedHomePath: O })
    ).rejects.toThrow('Codex account files are temporarily locked. Retry in a moment.')
    expect(store.getSettings().activeCodexManagedAccountId).toBe('account-1')
    filesystemFailure.path = ''
    await expect(
      service.prepareForCodexLaunchAsync(undefined, undefined, { unavailableManagedHomePath: O })
    ).resolves.toBeTypeOf('string')
  })
})
