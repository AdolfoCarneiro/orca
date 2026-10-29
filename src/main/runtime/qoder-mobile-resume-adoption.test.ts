import './rpc/unused-default-rpc-methods.test-fixture'
import { expect, it, vi } from 'vitest'
import type { OwnedMobileTerminalCreateOptions } from './terminal/launch/mobile-terminal-create'
import type { SleepingAgentLaunchConfig } from '../../shared/agent-session-resume'
import { buildAgentResumeStartupPlan } from '../../shared/tui-agent-startup'

await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const { OrcaRuntimeService } = await import('./orca-runtime-test-mocks.spec')
const { store, TEST_WORKTREE_PATH } = await import('./orca-runtime-test-fixtures.spec')
const { detectAgentCommandsOnHost } = await import('../preflight/agent-detection')
const { bindPaneFirst, committingSpawn, registerBoundPty } =
  await import('./bind-first-pane.test-fixture')

type SpawnPane = { worktreeId?: string; tabId?: string; leafId?: string }

class QoderAdoptionRuntime extends OrcaRuntimeService {
  createOwned(worktreeId: string, opts: OwnedMobileTerminalCreateOptions) {
    return this.createRuntimeOwnedMobileSessionTerminal(worktreeId, false, undefined, opts)
  }

  retainedRecipe(ptyId: string, worktreeId: string) {
    return this.recordPtyWorktree(ptyId, worktreeId)
  }
}

it.each([
  'client_disconnected',
  'Terminal creation timed out',
  'quoted-agent-command',
  'wsl-inventory',
  'changed-replay',
  'inventory-outage',
  'surviving-recipe'
])('reconciles a paired Qoder resume after ambiguous creation: %s', async (scenario) => {
  const failure = scenario === 'Terminal creation timed out' ? scenario : 'client_disconnected'
  const { withPlatform } = await import('./orca-runtime-test-fixtures.spec')
  await withPlatform(scenario === 'wsl-inventory' ? 'win32' : 'darwin', async () => {
    vi.useFakeTimers()
    try {
      const { electronMocks } = await import('./orca-runtime-test-mocks.spec')
      const { TEST_WORKTREE_ID } = await import('./orca-runtime-test-fixtures.spec')
      vi.mocked(detectAgentCommandsOnHost).mockResolvedValue(new Set(['qoder']))
      // Copy the fixture store so main-owned bindings cannot leak into shared tests.
      const runtime = new QoderAdoptionRuntime({ ...store })
      runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
      let revealedRecipe: SleepingAgentLaunchConfig | undefined
      const revealTerminalSession = vi.fn(
        (_workspace: string, reveal: { launchConfig?: SleepingAgentLaunchConfig }) => {
          revealedRecipe = reveal.launchConfig
        }
      )
      runtime.setNotifier({
        focusTerminal: vi.fn(),
        worktreesChanged: vi.fn(),
        reposChanged: vi.fn(),
        activateWorktree: vi.fn(),
        createTerminal: vi.fn(),
        revealTerminalSession,
        splitTerminal: vi.fn(),
        renameTerminal: vi.fn(),
        closeTerminal: vi.fn(),
        closeSessionTab: vi.fn(),
        terminalFitOverrideChanged: vi.fn(),
        terminalDriverChanged: vi.fn()
      })
      const acceptedCommands: string[] = []
      const live: {
        id: string
        cwd: string
        title: string
        worktreeId: string
        terminalHandle: string
        wslDistro?: string
      }[] = []
      let connection = new AbortController()
      let inventoryUnavailable = false
      const kill = vi.fn((id: string) => {
        const index = live.findIndex((entry) => entry.id === id)
        if (index !== -1) {
          live.splice(index, 1)
        }
        return true
      })
      const spawn = vi.fn(
        async (args: SpawnPane & { command?: string; preAllocatedHandle?: string }) => {
          if (args.command) {
            acceptedCommands.push(args.command)
          }
          live.push({
            id: 'qoder-live-resume',
            cwd: TEST_WORKTREE_PATH,
            title: 'Qoder',
            worktreeId: TEST_WORKTREE_ID,
            terminalHandle: args.preAllocatedHandle ?? '',
            ...(scenario === 'wsl-inventory' ? { wslDistro: 'Ubuntu-Orca' } : {})
          })
          if (scenario === 'surviving-recipe') {
            const retained = runtime.retainedRecipe('qoder-live-resume', TEST_WORKTREE_ID)
            retained.launchAgent = 'qoder'
            retained.launchConfig = {
              agentCommand: 'trusted-qoder',
              agentArgs: 'trusted args',
              agentEnv: { TRUSTED: 'retained' }
            }
          }
          // Commit the spawn binding before losing only its response.
          if (args.worktreeId && args.tabId && args.leafId) {
            bindPaneFirst(runtime, {
              worktreeId: args.worktreeId,
              tabId: args.tabId,
              leafId: args.leafId,
              ptyId: 'qoder-live-resume'
            })
          }
          if (failure === 'client_disconnected') {
            connection.abort()
          }
          throw new Error(failure)
        }
      )
      runtime.setPtyController({
        spawn,
        listProcesses: async () => {
          if (inventoryUnavailable) {
            throw new Error('host offline')
          }
          return live
        },
        write: () => true,
        kill,
        getForegroundProcess: async () => null
      })
      const send = vi.fn((channel: string, payload: { command?: string }) => {
        if (channel === 'terminal:requestTabCreate') {
          if (payload.command) {
            acceptedCommands.push(payload.command)
          }
          if (failure === 'client_disconnected') {
            connection.abort()
          }
        }
      })
      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
      electronMocks.BrowserWindow.fromId.mockReturnValue({
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => false,
          send,
          setBackgroundThrottling: vi.fn(),
          capturePage: vi.fn(async () => null)
        }
      })
      const plan = buildAgentResumeStartupPlan({
        agent: 'qoder',
        providerSession: { key: 'session_id', id: 'same-qoder-session' },
        cmdOverrides: {},
        platform: 'darwin',
        agentArgs: '--captured-option',
        ...(scenario === 'quoted-agent-command' ? { agentCommand: "'qodercli'" } : {})
      })
      expect(plan).not.toBeNull()
      if (!plan) {
        throw new Error('missing resume plan')
      }
      const resume = {
        command: plan.launchCommand,
        launchAgent: 'qoder' as const,
        launchConfig: { ...plan.launchConfig, agentEnv: { OWNED_RECIPE: 'original value' } },
        activate: false,
        select: false,
        navigation: 'caller' as const,
        clientNavigationId: 'paired-phone',
        clientMutationId: 'stable-resume-mutation'
      }
      const first = runtime
        .createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
          ...resume,
          signal: connection.signal
        })
        .then(
          () => null,
          (error: unknown) => error
        )
      await vi.advanceTimersByTimeAsync(10_001)
      expect(await first).toBeInstanceOf(Error)
      expect(kill).not.toHaveBeenCalled()
      connection = new AbortController()
      if (scenario === 'inventory-outage') {
        inventoryUnavailable = true
        await expect(
          runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
            ...resume,
            signal: connection.signal
          })
        ).rejects.toThrow('runtime_unavailable')
        inventoryUnavailable = false
      }
      let retryError: unknown
      const retryPromise = runtime
        .createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
          ...resume,
          ...(scenario === 'changed-replay'
            ? { launchConfig: { ...resume.launchConfig, agentEnv: { CHANGED: 'retry' } } }
            : {}),
          signal: connection.signal
        })
        .catch((error: unknown) => {
          retryError = error
          return null
        })
      await vi.advanceTimersByTimeAsync(10_001)
      const retry = await retryPromise
      expect(acceptedCommands).toHaveLength(1)
      expect(acceptedCommands[0]).toBe(
        scenario === 'quoted-agent-command'
          ? "qoder '--resume' 'same-qoder-session'"
          : "qoder '--captured-option' '--resume' 'same-qoder-session'"
      )
      expect(
        retry?.tab,
        retryError instanceof Error ? retryError.message : undefined
      ).toMatchObject({ ptyId: 'qoder-live-resume', launchAgent: 'qoder' })
      expect(spawn).toHaveBeenCalledTimes(1)
      expect(send).not.toHaveBeenCalled()
      if (!retry) {
        throw new Error('missing adopted resume')
      }
      const pane = runtime.resolveTerminalPane(`${retry.tab.parentTabId}:${retry.tab.leafId}`)
      await runtime.focusTerminal(pane.handle)
      expect(revealTerminalSession).toHaveBeenCalledWith(
        TEST_WORKTREE_ID,
        expect.objectContaining({
          launchAgent: 'qoder',
          launchConfig:
            scenario === 'surviving-recipe'
              ? {
                  agentCommand: 'trusted-qoder',
                  agentArgs: 'trusted args',
                  agentEnv: { TRUSTED: 'retained' }
                }
              : expect.objectContaining({
                  agentCommand:
                    scenario === 'quoted-agent-command'
                      ? "'qodercli'"
                      : "qoder '--captured-option'",
                  agentArgs: plan.launchConfig.agentArgs,
                  agentEnv: { OWNED_RECIPE: 'original value' }
                })
        })
      )
      if (!revealedRecipe) {
        throw new Error('missing revealed recipe')
      }
      const relaunch = buildAgentResumeStartupPlan({
        agent: 'qoder',
        providerSession: { key: 'session_id', id: 'same-qoder-session' },
        cmdOverrides: { qoder: 'changed-default-command' },
        platform: 'darwin',
        agentCommand: revealedRecipe.agentCommand,
        agentArgs: revealedRecipe.agentArgs,
        agentEnv: revealedRecipe.agentEnv
      })
      if (!relaunch) {
        throw new Error('missing relaunch')
      }
      const restoredSpawn = vi.fn().mockResolvedValue({ id: 'intentional-restored-qoder' })
      runtime.setPtyController({
        spawn: committingSpawn(runtime, restoredSpawn),
        write: () => true,
        kill,
        getForegroundProcess: async () => null
      })
      await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
        command: relaunch.launchCommand,
        launchAgent: 'qoder',
        launchConfig: relaunch.launchConfig,
        env: relaunch.env,
        focus: false
      })
      expect(restoredSpawn).toHaveBeenCalledWith(
        expect.objectContaining({
          command:
            scenario === 'surviving-recipe'
              ? "trusted-qoder '--resume' 'same-qoder-session'"
              : acceptedCommands[0],
          env: expect.objectContaining(
            scenario === 'surviving-recipe'
              ? { TRUSTED: 'retained' }
              : { OWNED_RECIPE: 'original value' }
          )
        })
      )
      expect(kill).not.toHaveBeenCalled()
      if (scenario === 'wsl-inventory' && retry) {
        expect(
          runtime.resolveTerminalPane(`${retry.tab.parentTabId}:${retry.tab.leafId}`).hostPlatform
        ).toBe('linux')
      }
    } finally {
      vi.useRealTimers()
    }
  })
})

it.each(['missing-original', 'different-agent'])(
  'refuses unproven adopted launch recipe: %s',
  async (state) => {
    const { TEST_WORKTREE_ID } = await import('./orca-runtime-test-fixtures.spec')
    const { deriveRemoteRuntimeTerminalCreateHandle } =
      await import('./remote-runtime-terminal-create-identity')
    const handle = deriveRemoteRuntimeTerminalCreateHandle(
      'owned-phone',
      TEST_WORKTREE_ID,
      'unknown-operation'
    )
    const runtime = new QoderAdoptionRuntime({ ...store })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
    const tabId = 'original-owned-tab'
    const leafId = '55555555-5555-4555-8555-555555555555'
    registerBoundPty(runtime, 'unknown-owned-pty', TEST_WORKTREE_ID, null, {
      tabId,
      leafId,
      terminalHandle: handle,
      incarnationId: 'owned-prior-incarnation'
    })
    const retained = runtime.retainedRecipe('unknown-owned-pty', TEST_WORKTREE_ID)
    const originalPaneKey = runtime['paneOfPty'](retained).paneKey
    expect(originalPaneKey).toBe(`${tabId}:${leafId}`)
    const originalOwnership = retained.runtimeSessionOwned
    if (state === 'different-agent') {
      retained.launchAgent = 'codex'
    }
    const spawn = vi.fn()
    const kill = vi.fn()
    runtime.setPtyController({
      spawn,
      kill,
      write: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        {
          id: 'unknown-owned-pty',
          worktreeId: TEST_WORKTREE_ID,
          terminalHandle: handle,
          cwd: TEST_WORKTREE_PATH,
          title: 'Unknown'
        }
      ]
    })
    await expect(
      runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        command: 'qodercli --resume original',
        launchAgent: 'qoder',
        launchConfig: {
          agentCommand: "'qodercli'",
          agentArgs: '--guessed-retry',
          agentEnv: { GUESSED: 'not-authoritative' }
        },
        clientNavigationId: 'owned-phone',
        clientMutationId: 'unknown-operation',
        select: false
      })
    ).rejects.toThrow(
      state === 'different-agent' ? 'terminal_create_identity_conflict' : 'runtime_unavailable'
    )
    expect(spawn).not.toHaveBeenCalled()
    expect(kill).not.toHaveBeenCalled()
    expect(retained.launchConfig).toBeNull()
    expect(retained.launchAgent).toBe(state === 'different-agent' ? 'codex' : null)
    expect(retained.launchToken).toBeNull()
    expect(retained.launchIncarnationId).toBeNull()
    expect(runtime['paneOfPty'](retained)).toMatchObject({ tabId, paneKey: originalPaneKey })
    expect(retained.runtimeSessionOwned).toBe(originalOwnership)
    expect(runtime.resolveTerminalPane(`${tabId}:${leafId}`).handle).toBe(handle)
  }
)

it('releases abandoned dispatch capacity without guessing an expired live recipe', async () => {
  vi.useFakeTimers()
  try {
    const { TEST_WORKTREE_ID } = await import('./orca-runtime-test-fixtures.spec')
    const { deriveRemoteRuntimeTerminalCreateHandle } =
      await import('./remote-runtime-terminal-create-identity')
    vi.mocked(detectAgentCommandsOnHost)
      .mockReset()
      .mockResolvedValue(new Set(['qoder']))
    const runtime = new OrcaRuntimeService({ ...store })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
    let accept = false
    const inventory: {
      id: string
      worktreeId: string
      terminalHandle: string
      cwd: string
      title: string
    }[] = []
    const spawn = vi.fn(async (_args: SpawnPane) => {
      if (accept) {
        return { id: 'fresh-after-expiry' }
      }
      throw new Error('abandoned-create')
    })
    const kill = vi.fn()
    runtime.setPtyController({
      spawn: committingSpawn(runtime, spawn),
      kill,
      write: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => inventory
    })
    const request = {
      command: 'qodercli --resume original',
      launchAgent: 'qoder' as const,
      launchConfig: {
        agentCommand: 'qodercli',
        agentArgs: '--original',
        agentEnv: { ORIGINAL: 'owned' }
      },
      clientNavigationId: 'owned-phone',
      select: false
    }
    for (let index = 0; index < 4096; index++) {
      await runtime
        .createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
          ...request,
          clientMutationId: `abandoned-${index}`
        })
        .catch((error: unknown) => {
          if (!(error instanceof Error) || error.message !== 'abandoned-create') {
            throw error
          }
        })
    }
    accept = true
    await expect(
      runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        ...request,
        clientMutationId: 'fresh-mutation'
      })
    ).rejects.toThrow('runtime_unavailable')
    expect(spawn).toHaveBeenCalledTimes(4096)
    await vi.advanceTimersByTimeAsync(14 * 60_000)
    await expect(
      runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        ...request,
        clientMutationId: 'fresh-mutation'
      })
    ).rejects.toThrow('runtime_unavailable')
    expect(spawn).toHaveBeenCalledTimes(4096)
    await vi.advanceTimersByTimeAsync(2 * 60_000)
    const fresh = await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
      ...request,
      clientMutationId: 'fresh-mutation'
    })
    expect(fresh.tab.ptyId).toBe('fresh-after-expiry')
    inventory.push({
      id: 'expired-live-pty',
      worktreeId: TEST_WORKTREE_ID,
      terminalHandle: deriveRemoteRuntimeTerminalCreateHandle(
        'owned-phone',
        TEST_WORKTREE_ID,
        'abandoned-0'
      ),
      cwd: TEST_WORKTREE_PATH,
      title: 'Qoder'
    })
    await expect(
      runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        ...request,
        launchConfig: { ...request.launchConfig, agentEnv: { GUESSED: 'retry' } },
        clientMutationId: 'abandoned-0'
      })
    ).rejects.toThrow('runtime_unavailable')
    expect(spawn).toHaveBeenCalledTimes(4097)
    expect(kill).not.toHaveBeenCalled()
    expect(inventory).toHaveLength(1)
  } finally {
    vi.useRealTimers()
  }
}, 30_000)

it('recovers an unhinted allocated pane across a lost reply and a publication error, ignoring the retry pair', async () => {
  const { TEST_WORKTREE_ID } = await import('./orca-runtime-test-fixtures.spec')
  const runtime = new QoderAdoptionRuntime({ ...store })
  runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
  const request = {
    command: 'qodercli --resume original',
    launchAgent: 'qoder' as const,
    launchConfig: { agentCommand: 'qodercli', agentArgs: '--original', agentEnv: {} },
    createMutation: { clientIdentity: 'unhinted-phone', id: 'unhinted-operation' }
  }
  const inventory: {
    id: string
    worktreeId: string
    terminalHandle: string
    cwd: string
    title: string
  }[] = []
  let allocated: { tabId: string; leafId: string } | undefined
  const spawn = vi.fn(async (args: SpawnPane & { preAllocatedHandle?: string }) => {
    if (!args.tabId || !args.leafId || !args.preAllocatedHandle) {
      throw new Error('missing actual allocation')
    }
    allocated = { tabId: args.tabId, leafId: args.leafId }
    inventory.push({
      id: 'unhinted-live',
      worktreeId: TEST_WORKTREE_ID,
      terminalHandle: args.preAllocatedHandle,
      cwd: TEST_WORKTREE_PATH,
      title: 'Qoder'
    })
    throw new Error('lost-spawn-reply')
  })
  const kill = vi.fn()
  runtime.setPtyController({
    spawn,
    kill,
    write: () => true,
    getForegroundProcess: async () => null,
    listProcesses: async () => inventory
  })
  await expect(runtime.createOwned(TEST_WORKTREE_ID, request)).rejects.toThrow('lost-spawn-reply')
  expect(allocated).toBeDefined()
  await expect(
    runtime.createOwned(TEST_WORKTREE_ID, { ...request, launchAgent: 'codex' })
  ).rejects.toThrow('terminal_create_identity_conflict')
  expect(runtime.retainedRecipe('unhinted-live', TEST_WORKTREE_ID).runtimeSessionOwned).toBe(false)
  const retry = {
    ...request,
    identity: { tabId: 'retry-tab', leafId: '99999999-9999-4999-8999-999999999999' }
  }
  const unsubscribe = runtime.onMobileSessionTabsChanged(() => {
    throw new Error('publication-observer-failed')
  })
  try {
    await expect(runtime.createOwned(TEST_WORKTREE_ID, retry)).rejects.toThrow(
      'publication-observer-failed'
    )
    expect(runtime['ownedMobileDispatchRecipes'].size).toBe(1)
  } finally {
    unsubscribe()
  }
  const result = await runtime.createOwned(TEST_WORKTREE_ID, retry)
  expect(result.tab).toMatchObject({
    parentTabId: allocated?.tabId,
    leafId: allocated?.leafId,
    ptyId: 'unhinted-live',
    launchAgent: 'qoder',
    status: 'ready'
  })
  expect(result.tab.parentTabId).not.toBe(retry.identity.tabId)
  expect(runtime.resolveTerminalPane(`${result.tab.parentTabId}:${result.tab.leafId}`).ptyId).toBe(
    'unhinted-live'
  )
  expect(runtime['ownedMobileDispatchRecipes'].size).toBe(0)
  expect(spawn).toHaveBeenCalledOnce()
  expect(kill).not.toHaveBeenCalled()
})

it.each(['moved', 'closed', 'replaced'] as const)(
  'retains ordinary %s authority while inventory reconciliation waits',
  async (change) => {
    const { fixture } =
      await import('../persistence/loading-store/profile-state-delayed-authority-fixture')
    const { store: durable } = await fixture()
    const worktreeId = 'repo-local::/fixture/local'
    const runtime = new QoderAdoptionRuntime(durable)
    Object.assign(runtime, {
      resolveTerminalWorkspaceLaunchScope: async () => ({
        id: worktreeId,
        path: '/fixture/local',
        connectionId: null,
        repo: null,
        folderWorkspace: null
      })
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
    const request = {
      command: 'qodercli --resume original',
      launchAgent: 'qoder' as const,
      launchConfig: { agentCommand: 'qodercli', agentArgs: '--original', agentEnv: {} },
      keepPaneOnStartFailure: true as const,
      createMutation: { clientIdentity: 'authority-phone', id: 'authority-operation' },
      identity: {
        tabId: '11111111-1111-4111-8111-111111111111',
        leafId: '22222222-2222-4222-8222-222222222222'
      }
    }
    const incarnationId = '33333333-3333-4333-8333-333333333333'
    const inventory: {
      id: string
      worktreeId: string
      terminalHandle: string
      cwd: string
      title: string
      incarnationId: string
    }[] = []
    const spawn = vi.fn(async (args: SpawnPane & { preAllocatedHandle?: string }) => {
      if (!args.preAllocatedHandle) {
        throw new Error('missing actual handle')
      }
      inventory.push({
        id: 'original-live',
        worktreeId,
        terminalHandle: args.preAllocatedHandle,
        cwd: '/fixture/local',
        title: 'Qoder',
        incarnationId
      })
      throw new Error('lost-spawn-reply')
    })
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let hold = false
    const kill = vi.fn()
    runtime.setPtyController({
      spawn,
      kill,
      write: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => {
        if (hold) {
          entered.resolve()
          await release.promise
        }
        return inventory
      }
    })
    await expect(runtime.createOwned(worktreeId, request)).rejects.toThrow('lost-spawn-reply')
    await durable.persistPtyBinding({
      worktreeId,
      ...request.identity,
      ptyId: 'original-live',
      incarnationId
    })
    runtime.registerPty('original-live', worktreeId, null, {
      ...request.identity,
      terminalHandle: inventory[0].terminalHandle,
      incarnationId
    })
    hold = true
    const retry = runtime.createOwned(worktreeId, {
      ...request,
      identity: {
        tabId: 'unrelated-retry',
        leafId: '99999999-9999-4999-8999-999999999999'
      }
    })
    const observed = retry.then(
      (value) => ({ value, error: null }),
      (error: unknown) => ({ value: null, error })
    )
    await entered.promise
    let movedTabId: string | undefined
    try {
      if (change === 'closed') {
        await runtime.closeTerminalSurfaceFromRenderer({
          worktreeId,
          target: { kind: 'tab', tabId: request.identity.tabId },
          reason: 'user'
        })
      } else {
        expect(
          await durable.persistPtyBinding({
            worktreeId,
            ...request.identity,
            ptyId: change === 'replaced' ? 'successor-live' : 'original-live',
            incarnationId
          })
        ).toBe(true)
        if (change === 'moved') {
          const moved = await durable.moveTerminalLeafToNewTab({
            worktreeId,
            sourceTabId: request.identity.tabId,
            targetTabId: '44444444-4444-4444-8444-444444444444',
            leafId: request.identity.leafId,
            ptyId: 'original-live'
          })
          expect(moved.status).toBe('moved')
          movedTabId =
            moved.status === 'moved'
              ? (moved.tabId ?? '44444444-4444-4444-8444-444444444444')
              : undefined
        }
      }
    } finally {
      release.resolve()
    }
    const outcome = await observed
    const session = durable.getWorkspaceSession()
    if (change === 'moved') {
      expect(outcome.error).toBeNull()
      expect(outcome.value?.tab).toMatchObject({
        parentTabId: movedTabId,
        leafId: request.identity.leafId,
        ptyId: 'original-live'
      })
      expect(
        session.terminalLayoutsByTabId[request.identity.tabId]?.ptyIdsByLeafId?.[
          request.identity.leafId
        ]
      ).not.toBe('original-live')
    } else {
      expect(outcome.error).toBeInstanceOf(Error)
      expect(outcome.value).toBeNull()
      expect(
        session.terminalLayoutsByTabId[request.identity.tabId]?.ptyIdsByLeafId?.[
          request.identity.leafId
        ]
      ).toBe(change === 'replaced' ? 'successor-live' : undefined)
    }
    expect(session.tabsByWorktree[worktreeId].some((tab) => tab.id === 'unrelated-retry')).toBe(
      false
    )
    expect(spawn).toHaveBeenCalledOnce()
    expect(kill).not.toHaveBeenCalled()
  }
)
