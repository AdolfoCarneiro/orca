// @vitest-environment happy-dom

import type { AppState } from '@/store/types'
import type { launchAgentInNewTab } from './launch-agent-in-new-tab'
import {
  createTestStore,
  makeWorktree,
  makeTab,
  makeUnifiedTab,
  makeTabGroup,
  seedStore,
  TEST_REPO
} from '@/store/slices/store-test-helpers'
import {
  drawTabsFromMain,
  type TabsDrawnFromMain
} from '@/store/slices/tabs-drawn-from-main.test-fixture'
import { layoutApplyTestTransport } from '@/runtime/layout-apply-test-transport.test-fixture'
import { isPendingTab } from '@/runtime/layout-owner-pending-tabs'
import {
  resetStructuredAgentLaunchRegistryForTests,
  getStructuredLaunchStateBySessionId
} from './agent-session/launch/structured-agent-session-launch-registry'
import { resetStructuredAgentLaunchPersistenceForTests } from './agent-session/launch/structured-agent-session-launch-persistence'
import type * as LaunchErrors from '@/lib/structured-agent-session-launch-errors'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockCreateTab = vi.hoisted(() => vi.fn())
const mockSetTabViewMode = vi.hoisted(() => vi.fn())
const mockWaitForAgentReady = vi.hoisted(() => vi.fn())
const mockPasteDraftWhenAgentReady = vi.hoisted(() => vi.fn())
const mockMarkNativeChatLaunchPromptFailed = vi.hoisted(() => vi.fn())
const mockCreateStructuredCodexSessionLaunchIntent = vi.hoisted(() => vi.fn())
const mockAbandonStructuredAgentSessionLaunchIntent = vi.hoisted(() => vi.fn())
const mockLaunchStructuredCodexSession = vi.hoisted(() => vi.fn())
const mockRefreshLocalStructuredSessionTabs = vi.hoisted(() => vi.fn())
const mockToastError = vi.hoisted(() => vi.fn())
const mockCallStructuredAgentSession = vi.hoisted(() => vi.fn())
const mockCreateSupport = vi.hoisted(() => vi.fn())
const mockCreateUnifiedTab = vi.hoisted(() => vi.fn<AppState['createUnifiedTab']>())
const mockRetryStructuredAgentSessionLaunchIntent = vi.hoisted(() =>
  vi.fn<
    (intent: ReturnType<typeof structuredLaunchIntent>) => ReturnType<typeof structuredLaunchIntent>
  >()
)
const STRUCTURED_HOST_CAPABILITIES = ['agent-session.structured.v1']
let hostCapabilities: readonly string[] | null = STRUCTURED_HOST_CAPABILITIES

function structuredLaunchIntent(worktreeId: string, sessionId = 'codex-session-1') {
  return {
    sessionId,
    worktreeId,
    executionHostId: 'local' as const,
    target: { kind: 'local' as const },
    params: {
      envelope: {
        sessionId,
        clientOperationId: `operation-${sessionId}`,
        expectedRuntimeFence: null,
        payloadFingerprint: 'f'.repeat(64)
      },
      worktree: `id:${worktreeId}`,
      agent: 'codex' as const
    }
  }
}

const owner = vi.hoisted((): { store: ReturnType<typeof createTestStore> | null } => ({
  store: null
}))
function state(): AppState {
  return owner.store!.getState()
}
vi.mock('@/store', async () =>
  (await import('./launch-parity-renderer.test-fixture')).launchStoreModuleMock(owner)
)
vi.mock('@/runtime/runtime-rpc-client', async (original) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await original())
)
vi.mock('@/runtime/runtime-layout-client', async (original) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await original())
)
vi.mock('sonner', () => ({ toast: { message: vi.fn(), error: mockToastError } }))
vi.mock('@/components/tab-bar/reconcile-order', () => ({ reconcileTabOrder: vi.fn(() => []) }))
vi.mock('@/lib/agent-paste-draft', () => ({
  pasteDraftWhenAgentReady: mockPasteDraftWhenAgentReady
}))
vi.mock('@/lib/agent-ready-wait', () => ({ waitForAgentReady: mockWaitForAgentReady }))
vi.mock('@/lib/telemetry', () => ({
  track: vi.fn(),
  tuiAgentToAgentKind: (agent: string) => agent
}))
vi.mock('@/runtime/web-runtime-terminal-creation', () => ({
  createWebRuntimeSessionTerminal: vi.fn(),
  createWebRuntimeAgentSessionTerminalWithLaunchDraft: vi.fn()
}))
vi.mock('@/runtime/web-runtime-session-environment', () => ({
  isWebRuntimeSessionActive: vi.fn(() => false)
}))
vi.mock('../../../shared/terminal-surface-id', () => ({
  isWebTerminalSurfaceTabId: vi.fn(() => false)
}))
const launchErrorMocks = vi.hoisted(() => {
  class StructuredAgentSessionCreateRefusalError extends Error {}
  class StructuredAgentSessionHostDeclinedError extends StructuredAgentSessionCreateRefusalError {}
  class StructuredAgentSessionHostUnreachableError extends StructuredAgentSessionCreateRefusalError {}
  class StructuredAgentSessionOwnerUnresolvedError extends Error {}
  return {
    StructuredAgentSessionCreateRefusalError,
    StructuredAgentSessionHostDeclinedError,
    StructuredAgentSessionHostUnreachableError,
    StructuredAgentSessionOwnerUnresolvedError
  }
})

vi.mock('@/lib/structured-agent-session-launch-errors', async () => ({
  ...(await vi.importActual<typeof LaunchErrors>('@/lib/structured-agent-session-launch-errors')),
  ...launchErrorMocks
}))

vi.mock('@/lib/structured-agent-session-launch-create-call', () => ({
  launchStructuredAgentSession: mockLaunchStructuredCodexSession
}))

vi.mock('@/lib/launch-structured-agent-session', () => {
  return {
    createStructuredAgentSessionLaunchIntent: mockCreateStructuredCodexSessionLaunchIntent,
    abandonStructuredAgentSessionLaunchIntent: mockAbandonStructuredAgentSessionLaunchIntent,
    retryStructuredAgentSessionLaunchIntent: mockRetryStructuredAgentSessionLaunchIntent,
    launchStructuredAgentSession: mockLaunchStructuredCodexSession,
    StructuredAgentSessionCreateRefusalError:
      launchErrorMocks.StructuredAgentSessionCreateRefusalError,
    StructuredAgentSessionHostDeclinedError:
      launchErrorMocks.StructuredAgentSessionHostDeclinedError,
    StructuredAgentSessionHostUnreachableError:
      launchErrorMocks.StructuredAgentSessionHostUnreachableError,
    StructuredAgentSessionOwnerUnresolvedError:
      launchErrorMocks.StructuredAgentSessionOwnerUnresolvedError
  }
})
vi.mock('@/runtime/local-structured-session-tabs-sync/inventory-refresh', () => ({
  refreshLocalStructuredSessionTabs: mockRefreshLocalStructuredSessionTabs
}))
vi.mock('@/runtime/local-structured-session-owner', () => ({
  LOCAL_STRUCTURED_SESSION_OWNER: 'local-structured-session'
}))
vi.mock('@/runtime/local-runtime-capabilities', () => ({
  readLocalRuntimeCapabilitiesOrUnknown: () => hostCapabilities,
  ensureLocalRuntimeCapabilities: async () => hostCapabilities,
  awaitLocalRuntimeCapabilities: () => ({ known: Promise.resolve([]), stop: () => {} })
}))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getExecutionHostIdForWorktree: () =>
    state().repos[0]?.connectionId ? `ssh:${state().repos[0]!.connectionId}` : 'local',
  runtimeEnvironmentIdOrLocalUnlessTwin: () => null
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: (target: unknown, method: string, params: unknown) =>
    method === 'agentSession.createSupport'
      ? mockCreateSupport()
      : mockCallStructuredAgentSession(target, method, params)
}))

let main: TabsDrawnFromMain
let warnings: ReturnType<typeof vi.spyOn<typeof console, 'warn'>>
const owned: ReturnType<typeof launchAgentInNewTab>[] = []
const lateCreates: (() => void)[] = []
// No initial chat mode proves availability rejection preceded terminal-tab adoption.
describe('structured chat adoption guard on the launch path', () => {
  beforeEach(async () => {
    vi.resetAllMocks()
    localStorage.clear()
    resetStructuredAgentLaunchRegistryForTests()
    resetStructuredAgentLaunchPersistenceForTests()
    owner.store = createTestStore()
    const chat = makeUnifiedTab({
      id: 'structured-agent-session-codex-session-1',
      contentType: 'agent-session',
      entityId: 'codex-session-1',
      worktreeId: 'wt-1',
      groupId: 'group-1'
    })
    seedStore(owner.store, {
      activeRepoId: 'repo-1',
      activeWorktreeId: 'wt-1',
      settings: {
        ...state().settings,
        agentCmdOverrides: {},
        agentDefaultArgs: {},
        agentDefaultEnv: {},
        activeRuntimeEnvironmentId: null,
        experimentalNativeChat: true,
        nativeChatSessionOptions: undefined
      },
      projects: [
        {
          id: 'repo-1',
          displayName: 'repo',
          badgeColor: '',
          sourceRepoIds: ['repo-1'],
          createdAt: 0,
          updatedAt: 0,
          localWindowsRuntimePreference: { kind: 'inherit-global' }
        }
      ],
      repos: [{ ...TEST_REPO, id: 'repo-1', connectionId: null, path: '/repo' }],
      sshConnectionStates: new Map(
        ['ssh-a', 'runtime-ssh-a'].map((targetId) => [
          targetId,
          {
            targetId,
            status: 'connected' as const,
            error: null,
            reconnectAttempt: 0,
            remotePlatform: 'linux' as const
          }
        ])
      ),
      runtimeStatusByEnvironmentId: new Map([
        [
          'web-runtime',
          {
            checkedAt: 0,
            status: {
              hostPlatform: 'linux',
              runtimeId: 'web-runtime',
              rendererGraphEpoch: 0,
              graphStatus: 'ready',
              authoritativeWindowId: null,
              liveTabCount: 0,
              liveLeafCount: 0,
              runtimeProtocolVersion: 3,
              minCompatibleRuntimeClientVersion: 3
            }
          }
        ]
      ]),
      worktreesByRepo: {
        'repo-1': [
          makeWorktree({
            id: 'wt-1',
            repoId: 'repo-1',
            path: '/repo/worktree',
            projectId: 'repo-1'
          })
        ]
      },
      tabsByWorktree: { 'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })] },
      unifiedTabsByWorktree: { 'wt-1': [chat] },
      groupsByWorktree: {
        'wt-1': [
          makeTabGroup({
            id: 'group-1',
            worktreeId: 'wt-1',
            tabOrder: [chat.id],
            activeTabId: chat.id
          })
        ]
      },
      layoutByWorktree: { 'wt-1': { type: 'leaf', groupId: 'group-1' } },
      activeGroupIdByWorktree: { 'wt-1': 'group-1' }
    })
    mockCreateUnifiedTab.mockImplementation(state().createUnifiedTab)
    owner.store.setState({
      createUnifiedTab: mockCreateUnifiedTab,
      createTab: mockCreateTab,
      setTabViewMode: mockSetTabViewMode,
      markNativeChatLaunchPromptFailed: mockMarkNativeChatLaunchPromptFailed
    })
    mockCreateTab.mockReturnValue({ id: 'tab-1' })
    main = await drawTabsFromMain(owner.store)
    warnings = vi.spyOn(console, 'warn')
    mockWaitForAgentReady.mockResolvedValue({ ready: true, reason: 'foreground-match' })
    mockPasteDraftWhenAgentReady.mockResolvedValue(true)
    mockCreateStructuredCodexSessionLaunchIntent.mockImplementation((worktreeId: string) =>
      structuredLaunchIntent(worktreeId)
    )
    mockRetryStructuredAgentSessionLaunchIntent.mockImplementation((intent) => ({
      ...intent,
      params: {
        ...intent.params,
        envelope: {
          ...intent.params.envelope,
          clientOperationId: `${intent.params.envelope.clientOperationId}-retry`
        }
      }
    }))
    mockLaunchStructuredCodexSession.mockResolvedValue({
      sessionId: 'codex-session-1',
      fence: 1
    })
    mockCallStructuredAgentSession.mockResolvedValue({
      ok: true,
      page: { fence: 1 },
      value: { submission: { dispatchState: 'accepted' } }
    })
    mockRefreshLocalStructuredSessionTabs.mockResolvedValue([
      {
        worktree: 'wt-1',
        tabs: [{ type: 'agent-session', sessionId: 'codex-session-1' }]
      }
    ])
    mockCreateSupport.mockResolvedValue({ supported: true })
    hostCapabilities = STRUCTURED_HOST_CAPABILITIES
    const module = await import('./launch-agent-in-new-tab')
    const launch = module.launchAgentInNewTab
    vi.spyOn(module, 'launchAgentInNewTab').mockImplementation((args) => {
      const result = launch(args)
      owned.push(result)
      return result
    })
  })

  afterEach(async () => {
    const { cancelStructuredAgentLaunch, retireStructuredAgentSessionLaunchCancellationTombstone } =
      await import('./structured-agent-session-launch')
    const pending = ['codex-session-1', 'codex-session-2'].flatMap((id) => {
      const launch = getStructuredLaunchStateBySessionId(id)
      return launch ? [launch.promise] : []
    })
    for (const sessionId of ['codex-session-1', 'codex-session-2']) {
      cancelStructuredAgentLaunch('wt-1', sessionId)
    }
    for (const finish of lateCreates.splice(0)) {
      finish()
    }
    await Promise.allSettled(pending)
    await Promise.all(owned.splice(0).map((result) => result?.structuredSettlement))
    await main.settle()
    expect(lateCreates).toEqual([])
    expect(layoutApplyTestTransport.pendingCount).toBe(0)
    for (const tab of state().unifiedTabsByWorktree['wt-1'] ?? []) {
      expect(isPendingTab(tab.id)).toBe(false)
    }
    expect(
      warnings.mock.calls.filter(
        ([message]) => message === '[layout-owner] pending tab waiter threw:'
      )
    ).toEqual([])
    for (const id of ['codex-session-1', 'codex-session-2']) {
      retireStructuredAgentSessionLaunchCancellationTombstone('wt-1', id)
    }
    main.close()
    vi.restoreAllMocks()
    owner.store = null
  })

  it('takes the structured path when the chat-default view is selected', async () => {
    const { launchAgentInNewTab, shouldQueueTerminalFocusAfterMenuClose } =
      await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      requestId: 'request-1',
      agent: 'codex',
      worktreeId: 'wt-1'
    })

    expect(result).toMatchObject({
      surface: { kind: 'host-published' },
      pasteDraftAfterLaunch: false
    })
    expect(mockCreateStructuredCodexSessionLaunchIntent).not.toHaveBeenCalled()
    expect(shouldQueueTerminalFocusAfterMenuClose(result!)).toBe(true)
    await expect(result?.structuredSettlement).resolves.toEqual({
      kind: 'structured',
      sessionId: 'codex-session-1'
    })
    expect(mockCreateStructuredCodexSessionLaunchIntent).toHaveBeenCalledWith(
      'wt-1',
      'codex',
      'local',
      undefined,
      undefined,
      undefined
    )
    expect(mockLaunchStructuredCodexSession).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: 'wt-1' }),
      expect.any(Function),
      false,
      expect.any(Function)
    )
    expect(mockCreateTab).not.toHaveBeenCalled()
    expect(mockWaitForAgentReady).not.toHaveBeenCalled()
  })

  it('takes the structured path when a Codex model and effort are already saved', async () => {
    owner.store!.setState({
      settings: {
        ...state().settings,
        nativeChatSessionOptions: {
          codex: { model: 'gpt-5.6-sol', valuesByModel: { 'gpt-5.6-sol': { effort: 'medium' } } }
        }
      }
    })
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      requestId: 'request-2',
      agent: 'codex',
      worktreeId: 'wt-1'
    })

    expect(result).toMatchObject({ surface: { kind: 'host-published' } })
    await result?.structuredSettlement
    expect(mockCreateStructuredCodexSessionLaunchIntent).toHaveBeenCalledWith(
      'wt-1',
      'codex',
      'local',
      undefined,
      undefined,
      undefined
    )
    expect(mockCreateTab).not.toHaveBeenCalled()
  })

  it('takes the structured path for Claude, naming Claude as the create provider', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      requestId: 'request-3',
      agent: 'claude',
      worktreeId: 'wt-1'
    })

    expect(result).toMatchObject({ surface: { kind: 'host-published' } })
    await result?.structuredSettlement
    expect(mockCreateStructuredCodexSessionLaunchIntent).toHaveBeenCalledWith(
      'wt-1',
      'claude',
      'local',
      undefined,
      undefined,
      undefined
    )
    expect(mockCreateTab).not.toHaveBeenCalled()
  })

  // WSL-bound Claude accounts must decline before opening a chat that could only fail Retry.
  it('opens the terminal, and no chat, when this machine declines the chat', async () => {
    owner.store!.setState({ unifiedTabsByWorktree: {} })
    mockCreateSupport.mockResolvedValue({ supported: false, reason: 'wsl' })
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      requestId: 'request-declined',
      agent: 'claude',
      worktreeId: 'wt-1',
      prompt: 'start this task',
      promptDelivery: 'submit-after-ready'
    })

    expect(mockCreateTab).not.toHaveBeenCalled()
    await expect(result?.structuredSettlement).resolves.toEqual({ kind: 'terminal' })
    await expect(result?.promptDeliveryResult).resolves.toEqual({
      delivered: true,
      failureNotified: false
    })
    expect(mockCreateTab).toHaveBeenCalledOnce()
    expect(mockPasteDraftWhenAgentReady).toHaveBeenCalledOnce()
    expect(mockPasteDraftWhenAgentReady).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'start this task' })
    )
    expect(mockCreateStructuredCodexSessionLaunchIntent).not.toHaveBeenCalled()
    expect(mockLaunchStructuredCodexSession).not.toHaveBeenCalled()
    expect(mockCreateUnifiedTab).not.toHaveBeenCalled()
    expect(localStorage.length).toBe(0)
    expect(mockToastError).not.toHaveBeenCalled()
  })

  it('keeps a native-chat agent with no structured adapter on the terminal-backed path', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({ requestId: 'request-4', agent: 'openclaude', worktreeId: 'wt-1' })

    expect(mockCreateStructuredCodexSessionLaunchIntent).not.toHaveBeenCalled()
    expect(mockCreateTab).toHaveBeenCalled()
  })

  it.each([[], null])(
    'preserves terminal-backed launches with capability answer %s',
    async (capabilities) => {
      hostCapabilities = capabilities
      const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

      const launches = [
        launchAgentInNewTab({ requestId: 'request-5', agent: 'claude', worktreeId: 'wt-1' }),
        launchAgentInNewTab({ requestId: 'request-6', agent: 'codex', worktreeId: 'wt-1' })
      ]
      // With no answer yet, each launch waits (bounded) for the runtime before opening its terminal.
      await Promise.all(launches.map((launch) => launch?.structuredSettlement))

      expect(mockCreateStructuredCodexSessionLaunchIntent).not.toHaveBeenCalled()
      expect(mockCreateTab).toHaveBeenCalledTimes(2)
    }
  )

  // Recheck persisted opt-in against current default view; the hidden toggle can remain enabled under Terminal chat.
  it('ignores a stale structured opt-in while the default view is Terminal chat', async () => {
    owner.store!.setState({ settings: { ...state().settings, experimentalNativeChat: false } })
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      requestId: 'request-7',
      agent: 'codex',
      worktreeId: 'wt-1'
    })

    expect(result?.surface).toEqual({ kind: 'local-terminal', tabId: 'tab-1' })
    expect(mockLaunchStructuredCodexSession).not.toHaveBeenCalled()
    expect(mockCreateTab).toHaveBeenCalledWith(
      'wt-1',
      undefined,
      undefined,
      expect.objectContaining({ launchAgent: 'codex' })
    )
  })

  it('does not open a terminal on a definitive refusal', async () => {
    const { StructuredAgentSessionCreateRefusalError } =
      await import('./launch-structured-agent-session')
    const refusal = new StructuredAgentSessionCreateRefusalError('provider unavailable')
    mockLaunchStructuredCodexSession.mockRejectedValueOnce(refusal)
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      requestId: 'request-8',
      agent: 'codex',
      worktreeId: 'wt-1'
    })

    expect(result).toMatchObject({
      surface: { kind: 'host-published' },
      pasteDraftAfterLaunch: false
    })
    await expect(result?.structuredSettlement).resolves.toEqual({
      kind: 'failed',
      error: refusal
    })
    expect(mockCreateTab).not.toHaveBeenCalled()
    expect(state().unifiedTabsByWorktree['wt-1']).toContainEqual(
      expect.objectContaining({ contentType: 'agent-session', entityId: 'codex-session-1' })
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(mockToastError).not.toHaveBeenCalled()
  })

  it('reports no prompt delivery from a definitive refusal', async () => {
    const { StructuredAgentSessionCreateRefusalError } =
      await import('./launch-structured-agent-session')
    mockLaunchStructuredCodexSession.mockRejectedValueOnce(
      new StructuredAgentSessionCreateRefusalError('provider unavailable')
    )
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      requestId: 'request-9',
      agent: 'codex',
      worktreeId: 'wt-1',
      prompt: 'start this task',
      promptDelivery: 'submit-after-ready'
    })

    await expect(result?.promptDeliveryResult).resolves.toEqual({
      delivered: false,
      failureNotified: true
    })
    await expect(result?.structuredSettlement).resolves.toMatchObject({
      kind: 'failed'
    })
    expect(mockCreateTab).not.toHaveBeenCalled()
    expect(mockPasteDraftWhenAgentReady).not.toHaveBeenCalled()
  })

  it('coalesces one action delivered twice for one worktree while the host is starting', async () => {
    let resolveLaunch!: (receipt: { sessionId: string; fence: number }) => void
    mockLaunchStructuredCodexSession.mockImplementationOnce(
      () =>
        new Promise<{ sessionId: string; fence: number }>((resolve) => {
          resolveLaunch = resolve
          lateCreates.push(() => resolve({ sessionId: 'codex-session-1', fence: 1 }))
        })
    )
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const first = launchAgentInNewTab({
      requestId: 'double-click',
      agent: 'codex',
      worktreeId: 'wt-1'
    })
    const second = launchAgentInNewTab({
      requestId: 'double-click',
      agent: 'codex',
      worktreeId: 'wt-1'
    })

    expect(first).toMatchObject({ surface: { kind: 'host-published' } })
    expect(second).toMatchObject({ surface: { kind: 'host-published' } })
    await vi.waitFor(() => expect(mockLaunchStructuredCodexSession).toHaveBeenCalledOnce())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(mockLaunchStructuredCodexSession).toHaveBeenCalledTimes(1)
    expect(mockCreateStructuredCodexSessionLaunchIntent).toHaveBeenCalledTimes(1)
    resolveLaunch({ sessionId: 'codex-session-1', fence: 1 })
    await Promise.all([first?.structuredSettlement, second?.structuredSettlement])
  })

  it('settles a successful create and opens its chat without an inventory refresh', async () => {
    owner.store!.setState({ unifiedTabsByWorktree: {} })
    expect(state().getTab('structured-agent-session-codex-session-1')).toBeNull()
    mockRefreshLocalStructuredSessionTabs.mockRejectedValue(new Error('inventory unavailable'))
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      requestId: 'double-click',
      agent: 'codex',
      worktreeId: 'wt-1'
    })

    await expect(result?.structuredSettlement).resolves.toEqual({
      kind: 'structured',
      sessionId: 'codex-session-1'
    })
    expect(state().unifiedTabsByWorktree['wt-1']).toContainEqual(
      expect.objectContaining({ contentType: 'agent-session', entityId: 'codex-session-1' })
    )
    await main.settle()
    const tab = state().unifiedTabsByWorktree['wt-1']!.find(
      (row) => row.entityId === 'codex-session-1'
    )!
    expect(state().getTab(tab.id)).toBe(tab)
    expect(mockRefreshLocalStructuredSessionTabs).not.toHaveBeenCalled()
    expect(mockToastError).not.toHaveBeenCalled()
  })

  it('re-checks a chat whose visibility proof is unknown through its own Retry, with its own intent', async () => {
    owner.store!.setState({ unifiedTabsByWorktree: {} })
    const firstIntent = structuredLaunchIntent('wt-1', 'codex-session-1')
    const secondIntent = structuredLaunchIntent('wt-1', 'codex-session-2')
    mockCreateStructuredCodexSessionLaunchIntent
      .mockReturnValueOnce(firstIntent)
      .mockReturnValueOnce(secondIntent)
    mockLaunchStructuredCodexSession
      .mockRejectedValueOnce(new Error('response lost'))
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce({ sessionId: secondIntent.sessionId, fence: 1 })
    mockRefreshLocalStructuredSessionTabs
      .mockRejectedValueOnce(new Error('inventory unavailable'))
      .mockResolvedValueOnce([])
      .mockImplementationOnce(() => {
        owner.store!.setState({
          unifiedTabsByWorktree: {
            'wt-1': [
              makeUnifiedTab({
                id: `structured-agent-session-${firstIntent.sessionId}`,
                contentType: 'agent-session',
                entityId: firstIntent.sessionId,
                worktreeId: 'wt-1',
                groupId: 'group-1'
              })
            ]
          }
        })
        return Promise.resolve([
          { worktree: 'wt-1', tabs: [{ type: 'agent-session', sessionId: firstIntent.sessionId }] }
        ])
      })
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const unknown = launchAgentInNewTab({
      requestId: 'request-14',
      agent: 'codex',
      worktreeId: 'wt-1'
    })
    await expect(unknown?.structuredSettlement).resolves.toEqual({
      kind: 'visibility-unknown',
      sessionId: firstIntent.sessionId
    })
    expect(mockCreateTab).not.toHaveBeenCalled()
    expect(mockCreateUnifiedTab).toHaveBeenCalledWith(
      'wt-1',
      'agent-session',
      expect.objectContaining({ entityId: firstIntent.sessionId })
    )
    expect(mockToastError).not.toHaveBeenCalled()

    // A new launch would open a new chat; the unconfirmed one is re-checked by its own Retry.
    const { retryStructuredAgentSessionLaunch } = await import('./structured-agent-session-launch')
    expect(retryStructuredAgentSessionLaunch('wt-1', firstIntent.sessionId)).toBe(true)
    await vi.waitFor(() => expect(mockRefreshLocalStructuredSessionTabs).toHaveBeenCalledTimes(3))

    expect(mockCreateStructuredCodexSessionLaunchIntent).toHaveBeenCalledTimes(1)
    expect(mockLaunchStructuredCodexSession).toHaveBeenCalledTimes(2)
    expect(mockLaunchStructuredCodexSession.mock.calls[0]?.[0]).toBe(firstIntent)
    expect(mockLaunchStructuredCodexSession.mock.calls[1]?.[0]).toBe(firstIntent)
    expect(mockLaunchStructuredCodexSession.mock.calls[0]?.[2]).toBe(false)
    expect(mockLaunchStructuredCodexSession.mock.calls[1]?.[2]).toBe(true)
    expect(mockRetryStructuredAgentSessionLaunchIntent).not.toHaveBeenCalled()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(mockCallStructuredAgentSession).toHaveBeenCalledWith(
      firstIntent.target,
      'agentSession.history',
      expect.objectContaining({ sessionId: firstIntent.sessionId })
    )

    const next = launchAgentInNewTab({
      requestId: 'request-15',
      agent: 'codex',
      worktreeId: 'wt-1'
    })
    await expect(next?.structuredSettlement).resolves.toEqual({
      kind: 'structured',
      sessionId: secondIntent.sessionId
    })
    expect(mockCreateStructuredCodexSessionLaunchIntent).toHaveBeenCalledTimes(2)
    expect(mockLaunchStructuredCodexSession).toHaveBeenCalledTimes(3)
    expect(mockLaunchStructuredCodexSession.mock.calls[2]?.[0]).toBe(secondIntent)
    expect(state().unifiedTabsByWorktree['wt-1']?.map((tab) => tab.entityId)).toEqual(
      expect.arrayContaining([firstIntent.sessionId, secondIntent.sessionId])
    )
    const replacement = state().unifiedTabsByWorktree['wt-1']!.find(
      (row) => row.entityId === secondIntent.sessionId
    )!
    owner.store!.setState({ unifiedTabsByWorktree: { 'wt-1': [replacement] } })
    expect(state().getTab(`structured-agent-session-${firstIntent.sessionId}`)).toBeNull()
    expect(state().getTab(replacement.id)).toBe(replacement)
  })

  it('routes an auto-submitted Codex prompt through the structured outbox', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      requestId: 'request-16',
      agent: 'codex',
      worktreeId: 'wt-1',
      prompt: 'start this task'
    })

    expect(result).toMatchObject({ surface: { kind: 'host-published' } })
    await expect(result?.promptDeliveryResult).resolves.toEqual({
      delivered: true,
      failureNotified: false
    })
    expect(mockCreateTab).not.toHaveBeenCalled()
  })

  it("puts a refused structured prompt in the new chat's composer", async () => {
    mockCallStructuredAgentSession.mockResolvedValueOnce({
      ok: false,
      refusal: { code: 'agent_session_busy', message: 'busy' }
    })
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      requestId: 'request-17',
      agent: 'codex',
      worktreeId: 'wt-1',
      prompt: 'large generated prompt',
      promptDelivery: 'submit-after-ready'
    })

    await expect(result?.promptDeliveryResult).resolves.toEqual({
      delivered: false,
      failureNotified: false,
      inComposer: true
    })
    expect(mockCreateTab).not.toHaveBeenCalled()
  })

  it('keeps an SSH Codex tab on the bridge', async () => {
    owner.store!.setState({ repos: [{ ...state().repos[0]!, connectionId: 'ssh-a' }] })
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({ requestId: 'request-18', agent: 'codex', worktreeId: 'wt-1' })

    expect(mockCreateTab).toHaveBeenCalledWith(
      'wt-1',
      undefined,
      undefined,
      expect.objectContaining({ launchAgent: 'codex' })
    )
    expect(mockCreateTab.mock.calls[0]?.[3]).not.toHaveProperty('viewMode')
    expect(mockWaitForAgentReady).not.toHaveBeenCalled()
  })

  it('keeps a runtime-paired Codex tab on the bridge', async () => {
    owner.store!.setState({ repos: [{ ...state().repos[0]!, connectionId: 'runtime-ssh-a' }] })
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({ requestId: 'request-19', agent: 'codex', worktreeId: 'wt-1' })

    expect(mockCreateTab).toHaveBeenCalledWith(
      'wt-1',
      undefined,
      undefined,
      expect.objectContaining({ launchAgent: 'codex' })
    )
    expect(mockCreateTab.mock.calls[0]?.[3]).not.toHaveProperty('viewMode')
    expect(mockWaitForAgentReady).not.toHaveBeenCalled()
  })
})
