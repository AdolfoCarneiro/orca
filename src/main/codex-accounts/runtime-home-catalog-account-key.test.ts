import type * as NodeOs from 'node:os'
import type * as NodeFs from 'node:fs'
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import type { AgentSessionAccountHome } from '../../shared/agent-session-account-home'
import { requireLegacyAgentSessionAccountHome } from '../../shared/agent-session-account-home'
import {
  resolveCodexLaunchHome,
  type CodexHomePreparationOperation
} from '../codex/codex-launch-home'
import { createSettings } from './runtime-home-settings-test-fixtures'
import {
  createCodexAccountRecord,
  createCodexAuthJson,
  createManagedAuth,
  createStore,
  getSystemCodexHomePath,
  setupRuntimeHomeTest,
  teardownRuntimeHomeTest,
  testState
} from './runtime-home-service-test-harness'

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.userDataDir
  }
}))
beforeEach(() => installFakeAppEnvironment({ getPath: () => testState.userDataDir }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return { ...actual, readdirSync: vi.fn(actual.readdirSync) }
})

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os')
  return {
    ...actual,
    homedir: () => testState.fakeHomeDir
  }
})

// Hook install and session bridges are launch chores outside the key; keep them off disk.
vi.mock('../codex/codex-account-home-hook', () => ({
  reconcileCodexAccountHomeHook: async () => {}
}))
vi.mock('../codex/hook-service', () => ({
  codexHookService: { prepareRuntimeHomeForLaunch: async () => ({ state: 'installed' }) }
}))
vi.mock('../codex/codex-hook-reconcile', () => ({ reconcileCodexHooksForLaunch: async () => {} }))
vi.mock('../codex/codex-session-bridge', () => ({
  startSystemCodexSessionBridgeInBackground: async () => {}
}))
vi.mock('../codex/codex-account-session-bridge', () => ({
  startCodexAccountSessionBridgeInBackground: async () => {}
}))

// Use production wiring so catalog reads and launches cannot silently drift apart.
async function wireCodexAccountKey(
  settings: ReturnType<typeof createSettings>,
  launchEnv: NodeJS.ProcessEnv = {}
) {
  const { CodexRuntimeHomeService } = await import('./runtime-home-service')
  const { mainProcessState } = await import('../startup/main-process-state')
  const { codexStructuredLaunchHomeResolvers } = await import('../startup/codex-launch-preparation')
  const { structuredAgentRuntimeRegistration } =
    await import('../runtime/structured-agent-runtime-registrations')
  const { agentModelCatalogFingerprint } =
    await import('../native-chat/agent-model-catalog/agent-model-catalog-fingerprint')
  const store = createStore(settings)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the harness store implements the settings surface consumed by the service.
  const runtimeHome = new CodexRuntimeHomeService(store as never)
  mainProcessState.codexRuntimeHome = runtimeHome
  const codex = structuredAgentRuntimeRegistration('codex')!
  const services = {
    getClaudeConfigDirectory: () => null,
    prepareCodexLaunchHome: codexStructuredLaunchHomeResolvers.prepareCodexStructuredLaunch,
    readCodexLaunchHome: codexStructuredLaunchHomeResolvers.resolveCodexStructuredLaunchHome,
    workspaceTrustSettings: () => settings,
    stateDirectory: '/orca-data'
  }
  const resolve = (purpose: 'launch' | 'read', conversationHome?: string) =>
    codex.resolveAccountHome(
      { launchEnv, location: null, purpose, workspacePath: null, conversationHome },
      services
    )
  const key = (accountHome: AgentSessionAccountHome) =>
    agentModelCatalogFingerprint({ agent: 'codex', accountHome, wslDistro: null })
  return {
    resolve,
    key,
    runtimeHome,
    store,
    release: () => (mainProcessState.codexRuntimeHome = null)
  }
}

describe('Codex catalog account key: picker read vs launch', () => {
  let release: (() => void) | null = null

  beforeEach(() => {
    setupRuntimeHomeTest()
  })

  afterEach(() => {
    vi.useRealTimers()
    release?.()
    release = null
    teardownRuntimeHomeTest()
  })

  it('probes the healthy store with an unrelated offline retained alias and observes its restoration', async () => {
    const login = createManagedAuth(
      testState.userDataDir,
      'account-1',
      createCodexAuthJson('user@example.com', 'acct-1', 'refresh-1')
    )
    const healthy = join(testState.fakeHomeDir, 'healthy-store')
    const removable = join(testState.fakeHomeDir, 'removable-store')
    mkdirSync(healthy)
    mkdirSync(removable)
    const retained = resolveCodexLaunchHome({
      selectedAccount: { homePath: login },
      storeHome: removable
    })!
    const link = readlinkSync(join(retained, 'sessions'))
    const offline = join(testState.fakeHomeDir, 'unmounted-store')
    renameSync(removable, offline)
    const settings = createSettings({
      realHomeRoutable: true,
      codexSessionSourceHome: { host: healthy },
      codexManagedAccounts: [
        createCodexAccountRecord('account-1', 'user@example.com', 'acct-1', login)
      ],
      activeCodexManagedAccountId: 'account-1',
      activeCodexManagedAccountIdsByRuntime: { host: 'account-1', wsl: {} }
    })
    const wired = await wireCodexAccountKey(settings)
    release = wired.release
    const inventoryCount = () =>
      vi
        .mocked(readdirSync)
        .mock.calls.filter(
          ([path]) => String(path) === join(testState.userDataDir, 'codex-accounts')
        ).length
    const { createCodexModelCatalogProbe } = await import('../codex/codex-model-catalog-probe')
    const { resolveStructuredCodexAccountKind } =
      await import('../runtime/structured-agent-account-home')
    let expectedHome = login
    const probe = createCodexModelCatalogProbe({
      resolveEnvironment: async () => ({}),
      resolveCommand: () => 'codex',
      resolveAccountKind: (home) =>
        resolveStructuredCodexAccountKind(home, wired.store.getSettings()),
      runSession: async (invocation, body) => {
        expect(invocation.env?.CODEX_HOME).toBe(expectedHome)
        return body({
          request: async (method) =>
            method === 'account/read'
              ? {
                  requiresOpenaiAuth: true,
                  account: { type: 'chatgpt', email: 'user@example.com', planType: 'plus' }
                }
              : method === 'config/read'
                ? { config: {} }
                : {
                    data: [
                      {
                        model: 'gpt-live',
                        displayName: 'GPT Live',
                        hidden: false,
                        supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
                        isDefault: true
                      }
                    ],
                    nextCursor: null
                  },
          notify: () => {}
        })
      }
    })
    for (const restored of [false, true]) {
      if (restored) {
        renameSync(offline, removable)
      }
      const read = await wired.resolve('read')
      expect(
        wired.runtimeHome
          .getHostCodexHomePathsForSessionDiscovery()
          .map((home) => home.replace('/private/var/', '/var/'))
      ).toEqual(
        expect.arrayContaining([
          retained.replace('/private/var/', '/var/'),
          join(testState.fakeHomeDir, 'removable-store').replace('/private/var/', '/var/')
        ])
      )
      vi.mocked(readdirSync).mockClear()
      expect(await probe(read)).toMatchObject({ models: [{ id: 'gpt-live' }], origin: 'probe' })
      expect(inventoryCount()).toBe(0)
      const fresh = requireLegacyAgentSessionAccountHome(await wired.resolve('launch')).path
      expect(fresh).not.toBe(login)
      expect(realpathSync(join(fresh, 'sessions'))).toBe(realpathSync(join(healthy, 'sessions')))
      expect(requireLegacyAgentSessionAccountHome(read).path).toBe(login)
      expect(readlinkSync(join(retained, 'sessions'))).toBe(link)
    }
    expectedHome = retained
    expect(await wired.resolve('read', retained)).toMatchObject({ path: retained })
    vi.mocked(readdirSync).mockClear()
    expect(await probe(await wired.resolve('read', retained))).toMatchObject({
      models: [{ id: 'gpt-live' }]
    })
    expect(inventoryCount()).toBe(0)
    expect(wired.store.getSettings().activeCodexManagedAccountId).toBe('account-1')
  })

  it('settles transient managed-overlay readiness through the real service and retains managed catalog recovery', async () => {
    const auth = createCodexAuthJson('user@example.com', 'acct-1', 'refresh-1')
    const login = createManagedAuth(testState.userDataDir, 'account-1', auth)
    const settings = createSettings({
      realHomeRoutable: true,
      codexManagedAccounts: [
        createCodexAccountRecord('account-1', 'user@example.com', 'acct-1', login)
      ],
      activeCodexManagedAccountId: 'account-1',
      activeCodexManagedAccountIdsByRuntime: { host: 'account-1', wsl: {} }
    })
    const wired = await wireCodexAccountKey(settings)
    release = wired.release
    const operation: CodexHomePreparationOperation = {}
    const overlay = (await wired.runtimeHome.prepareForCodexLaunchAsync(
      undefined,
      {},
      { conversationHome: getSystemCodexHomePath(), operation }
    ))!
    const recorded = { variable: 'CODEX_HOME' as const, path: overlay }
    const { resolveCodexHomeAfterManagedAuthReadiness } =
      await import('../ipc/pty/host-env/codex-home')
    writeFileSync(
      join(login, 'auth.json'),
      JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'access-acct-1' } })
    )
    vi.useFakeTimers()
    const resolveCurrent = vi.fn(() =>
      wired.runtimeHome.prepareForCodexLaunchAsync(
        undefined,
        {},
        { conversationHome: overlay, operation }
      )
    )
    const resolveAfterUnavailable = vi.fn((home: string) =>
      wired.runtimeHome.prepareForCodexLaunchAsync(
        undefined,
        {},
        { conversationHome: overlay, unavailableManagedHomePath: home, operation }
      )
    )
    const pending = resolveCodexHomeAfterManagedAuthReadiness({
      selectedCodexHomePath: overlay,
      getSettings: () => wired.store.getSettings(),
      target: { runtime: 'host' },
      resolveCurrent,
      resolveAfterUnavailable
    })
    expect(pending).toBeInstanceOf(Promise)
    await vi.advanceTimersByTimeAsync(50)
    writeFileSync(join(login, 'auth.json'), auth)
    await vi.advanceTimersByTimeAsync(25)
    await expect(pending).resolves.toBe(overlay)
    expect(resolveCurrent).toHaveBeenCalledOnce()
    expect(resolveAfterUnavailable).not.toHaveBeenCalled()
    vi.useRealTimers()
    expect(wired.store.getSettings().activeCodexManagedAccountId).toBe('account-1')
    expect(await wired.resolve('read', overlay)).toEqual(recorded)

    const { createCodexModelCatalogProbe } = await import('../codex/codex-model-catalog-probe')
    const { resolveStructuredCodexAccountKind } =
      await import('../runtime/structured-agent-account-home')
    const { AgentModelCatalogUnavailableError } =
      await import('../native-chat/agent-model-catalog/agent-model-catalog-unavailable')
    const { agentSessionSignInCopyId } = await import('../../shared/agent-session-availability')
    const probe = createCodexModelCatalogProbe({
      resolveEnvironment: async () => ({}),
      resolveCommand: () => 'codex',
      resolveAccountKind: (home) =>
        resolveStructuredCodexAccountKind(home, wired.store.getSettings()),
      runSession: async (invocation, body) => {
        expect(invocation.env?.CODEX_HOME).toBe(overlay)
        return body({
          request: async (method) =>
            method === 'account/read'
              ? { requiresOpenaiAuth: true, account: null }
              : method === 'config/read'
                ? { config: {} }
                : { data: [], nextCursor: null },
          notify: () => {}
        })
      }
    })
    unlinkSync(join(login, 'auth.json'))
    const failure: unknown = await probe(recorded).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AgentModelCatalogUnavailableError)
    if (!(failure instanceof AgentModelCatalogUnavailableError)) {
      throw new Error('Expected unavailable catalog')
    }
    expect(failure.unavailable).toEqual({ reason: 'notSignedIn', account: 'managed' })
    expect(
      agentSessionSignInCopyId(
        'codex',
        failure.unavailable.reason === 'notSignedIn' ? failure.unavailable.account : undefined
      )
    ).toBe('codexManagedNotSignedIn')
    expect(wired.store.getSettings().activeCodexManagedAccountId).toBe('account-1')
  })

  it('shares one actor through terminal readiness callbacks and gives fresh native acquisitions current H over saved X', async () => {
    const auth = createCodexAuthJson('user@example.com', 'acct-1', 'refresh-1')
    const login = createManagedAuth(testState.userDataDir, 'account-1', auth)
    const source = join(testState.fakeHomeDir, 'source')
    mkdirSync(source)
    const wired = await wireCodexAccountKey(
      createSettings({
        codexSessionSourceHome: { host: source },
        codexManagedAccounts: [
          createCodexAccountRecord('account-1', 'user@example.com', 'acct-1', login)
        ],
        activeCodexManagedAccountId: 'account-1',
        activeCodexManagedAccountIdsByRuntime: { host: 'account-1', wsl: {} }
      })
    )
    release = wired.release
    const { resolvePtySpawnHostEnv } = await import('../ipc/pty/spawn-host-env')
    const resume = await import('../ipc/pty/host-env/codex-resume')
    const { prepareCodexRuntimeHomeForLaunch } = await import('../startup/codex-launch-preparation')
    const { codexAccountOverlayHomes } = await import('../codex/codex-launch-home')
    writeFileSync(join(login, 'auth.json'), '{"tokens":{"access_token":"incomplete"}}')
    vi.useFakeTimers()
    const pending = resolvePtySpawnHostEnv({
      launchAgent: 'codex',
      command: 'codex',
      resumeProviderSession: undefined,
      env: undefined,
      cwd: undefined,
      shellOverride: undefined,
      expectedWslDistro: null,
      codexSelectionTarget: { runtime: 'host' },
      preAdopted: false,
      isDaemonHostSpawn: false,
      sessionId: undefined,
      callerNamedSession: false,
      mintedSessionId: false,
      resumeOnSelectedAccount: false,
      emptySessionIdSkipsHostEnv: false,
      requestedAgentTeamsPath: undefined,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: local env preparation returns before any provider access.
      provider: {} as never,
      deps: {
        prepareCodexResumeHome: () => null,
        noCodexResumeLaunch: resume.noCodexResumeLaunch,
        resolveCodexResumeLaunch: resume.resolveCodexResumeLaunch,
        reconcileSharedRuntimeResumeHome: resume.reconcileSharedRuntimeResumeHome,
        stripSequencedStartupResumeArgv: resume.stripSequencedStartupResumeArgv,
        getSettings: () => wired.store.getSettings(),
        getSelectedCodexHomePath: prepareCodexRuntimeHomeForLaunch
      }
    })
    await vi.advanceTimersByTimeAsync(50)
    const actors = codexAccountOverlayHomes(
      join(testState.userDataDir, 'codex-accounts', 'account-1')
    )
    expect(actors).toHaveLength(1)
    writeFileSync(join(login, 'auth.json'), auth)
    await vi.advanceTimersByTimeAsync(25)
    expect((await pending).selectedCodexHomePath).toBe(realpathSync(actors[0]!))
    expect(
      codexAccountOverlayHomes(join(testState.userDataDir, 'codex-accounts', 'account-1'))
    ).toEqual(actors)
    vi.useRealTimers()

    const old = actors[0]
    unlinkSync(join(old, 'auth.json'))
    writeFileSync(join(old, 'auth.json'), '{"account":"detached"}')
    writeFileSync(join(login, 'replacement'), auth)
    renameSync(join(login, 'replacement'), join(login, 'auth.json'))
    const { agentSessionRecordFixture } =
      await import('../native-chat/agent-session-record-test-fixture')
    const record = agentSessionRecordFixture({
      provider: 'codex',
      accountHome: { variable: 'CODEX_HOME', path: old }
    })
    const { createCodexStructuredLaunchResolver } =
      await import('../runtime/structured-agent-launch-composition.test-support')
    const resolve = createCodexStructuredLaunchResolver({
      store: { getRecord: () => record, pinLaunchDirectory: vi.fn() },
      resolveWorkspacePath: async () => testState.fakeHomeDir,
      resolveCommand: () => 'codex',
      resolveLaunchArgs: () => [],
      prepareLaunchHome: (input) =>
        wired.runtimeHome.prepareForCodexLaunchAsync(undefined, input.launchEnv, input)
    })
    const identity = {
      sessionId: record.sessionId,
      workspaceId: record.location.workspaceId,
      hostId: record.location.executionHostId,
      agent: record.provider
    }
    const first = await resolve({ identity })
    const second = await resolve({ identity })
    expect(first.codexHome).not.toBe(old)
    expect(second.codexHome).not.toBe(first.codexHome)
    expect(realpathSync(join(first.codexHome, 'sessions'))).toBe(
      realpathSync(join(source, 'sessions'))
    )
    expect(readFileSync(join(first.codexHome, 'auth.json'), 'utf8')).toBe(auth)
    expect(readFileSync(join(old, 'auth.json'), 'utf8')).toContain('detached')
    expect(await wired.resolve('read', old)).toMatchObject({ path: old })
  })

  async function expectOneKey(settings: ReturnType<typeof createSettings>, expectedPath: string) {
    const wired = await wireCodexAccountKey(settings)
    release = wired.release
    const before = await wired.resolve('read')
    const launched = await wired.resolve('launch')
    const after = await wired.resolve('read')

    expect(launched).toMatchObject({ variable: 'CODEX_HOME', path: expectedPath })
    expect(wired.key(before)).toBe(wired.key(launched))
    expect(wired.key(after)).toBe(wired.key(launched))
  }

  it('system account on the real ~/.codex', async () => {
    await expectOneKey(createSettings({ realHomeRoutable: true }), getSystemCodexHomePath())
  })

  it('system account no longer routes through the legacy mirror', async () => {
    await expectOneKey(createSettings({ realHomeRoutable: false }), getSystemCodexHomePath())
  })

  it('pins read and actual launch inputs to system selection despite a custom CODEX_HOME', async () => {
    const custom = '/fixture/custom-codex-home'
    const wired = await wireCodexAccountKey(createSettings({ realHomeRoutable: true }), {
      CODEX_HOME: custom
    })
    release = wired.release
    const read = await wired.resolve('read')
    const launched = await wired.resolve('launch')
    expect(requireLegacyAgentSessionAccountHome(read).path).toBe(getSystemCodexHomePath())
    expect(launched).toEqual(read)
    const { createCodexModelCatalogProbe } = await import('../codex/codex-model-catalog-probe')
    const probe = createCodexModelCatalogProbe({
      resolveEnvironment: async () => ({ CODEX_HOME: custom }),
      resolveCommand: () => 'codex',
      runSession: async (invocation, body) => {
        expect(invocation.env?.CODEX_HOME).toBe(requireLegacyAgentSessionAccountHome(launched).path)
        return body({
          request: async () => ({
            data: [
              {
                model: 'gpt-live',
                displayName: 'GPT Live',
                hidden: false,
                supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
                isDefault: true
              }
            ],
            nextCursor: null
          }),
          notify: () => {}
        })
      }
    })
    expect((await probe(read)).models.map((model) => model.id)).toEqual(['gpt-live'])
  })

  it('a managed account overlay over the shared conversation store', async () => {
    const managedHomePath = createManagedAuth(
      testState.userDataDir,
      'account-1',
      createCodexAuthJson('user@example.com', 'acct-1', 'refresh-1')
    )
    await expectOneKey(
      createSettings({
        realHomeRoutable: true,
        codexManagedAccounts: [
          createCodexAccountRecord('account-1', 'user@example.com', 'acct-1', managedHomePath)
        ],
        activeCodexManagedAccountId: 'account-1',
        activeCodexManagedAccountIdsByRuntime: { host: 'account-1', wsl: {} }
      }),
      resolveCodexLaunchHome({ selectedAccount: { homePath: managedHomePath }, readOnly: true })!
    )
  })
})

it('prepares registered H resources and current config through the default startup wrapper, then promotes H before a layered birth', async () => {
  setupRuntimeHomeTest()
  const login = createManagedAuth(
    testState.userDataDir,
    'account-1',
    createCodexAuthJson('one@example.test', 'one', 'one')
  )
  const settings = createSettings({
    codexManagedAccounts: [createCodexAccountRecord('account-1', 'one@example.test', 'one', login)],
    activeCodexManagedAccountId: 'account-1',
    activeCodexManagedAccountIdsByRuntime: { host: 'account-1', wsl: {} }
  })
  const system = getSystemCodexHomePath()
  mkdirSync(join(system, 'skills', 'example'), { recursive: true })
  writeFileSync(join(system, 'skills', 'example', 'SKILL.md'), 'skill')
  writeFileSync(join(system, 'AGENTS.md'), 'instructions')
  writeFileSync(join(system, 'config.toml'), 'model = "before"\n')
  const wired = await wireCodexAccountKey(settings)
  const { prepareCodexRuntimeHomeForLaunch } = await import('../startup/codex-launch-preparation')
  try {
    expect(await prepareCodexRuntimeHomeForLaunch()).toBe(login)
    expect(readFileSync(join(login, 'skills', 'example', 'SKILL.md'), 'utf8')).toBe('skill')
    expect(readFileSync(join(login, 'AGENTS.md'), 'utf8')).toContain('instructions')
    writeFileSync(join(system, 'config.toml'), 'model = "after"\n')
    expect(await prepareCodexRuntimeHomeForLaunch()).toBe(login)
    expect(readFileSync(join(login, 'config.toml'), 'utf8')).toContain('model = "after"')
    writeFileSync(join(login, 'config.toml'), 'model = "in-home"\n')
    const actor = await prepareCodexRuntimeHomeForLaunch(undefined, undefined, {
      conversationHome: system
    })
    expect(actor).not.toBe(login)
    expect(readFileSync(join(system, 'config.toml'), 'utf8')).toContain('model = "in-home"')
    expect(readFileSync(join(actor!, 'config.toml'), 'utf8')).toContain('model = "in-home"')
  } finally {
    wired.release()
    teardownRuntimeHomeTest()
  }
})
