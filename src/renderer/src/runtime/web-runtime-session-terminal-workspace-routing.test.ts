import { applyWebSessionTabsSnapshot } from './web-session-tabs-sync/snapshot-api'
import { resetWebSessionTabsSnapshotFreshnessForTests } from './web-session-tabs-sync/tracking-lifecycle'
import { createTestStore } from '../store/slices/store-test-helpers'
import {
  captureConversationSwitchViewerSelection,
  conversationSwitchViewerSelectionCurrent
} from '../lib/conversation-switch-selection'
import { structuredAgentSessionTabId } from '../../../shared/structured-agent-session-projection'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import type * as SnapshotApi from './web-session-tabs-sync/snapshot-api'
import type * as StorePatch from './web-session-tabs-sync/store-patch'
import type * as TrackingMappings from './web-session-tabs-sync/tracking-mappings'
import type * as TrackingDecisions from './web-session-tabs-sync/tracking-decisions'
import type * as TrackingLifecycle from './web-session-tabs-sync/tracking-lifecycle'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { createWebRuntimeSessionTerminal } from './web-runtime-terminal-creation'
import { resetWebSessionCloseIntentForTests } from './web-session-close-intent'
import {
  ENVIRONMENT_ID,
  RUNTIME_EXECUTION_HOST_ID,
  WORKTREE_ID,
  makeSnapshot,
  resetTerminalCreateEnvironment,
  stubTerminalCreateEnvironment
} from './web-runtime-session-test-harness'
import { stubRuntimeEnvironmentBridge } from './runtime-environment-bridge-fixture'

const mocks = vi.hoisted(() => ({
  realStore: false,
  getState: vi.fn(),
  setState: vi.fn(),
  subscribe: vi.fn(),
  setActiveWorktree: vi.fn(),
  createBrowserTab: vi.fn(),
  closeEmptyGroup: vi.fn(),
  moveUnifiedTabToGroup: vi.fn(),
  setRemoteBrowserPageHandle: vi.fn(),
  focusBrowserTabInWorktree: vi.fn(),
  applyWebSessionTabsSnapshot: vi.fn(),
  decideWebSessionTabsSnapshot: vi.fn<typeof TrackingDecisions.decideWebSessionTabsSnapshot>(
    () => ({ apply: true, settlesHostMirror: true })
  ),
  acceptReplayedWebSessionTabsSnapshot: vi.fn(),
  resolveHostSessionTabIdForWebSessionTab: vi.fn(),
  trackTerminalPaneSplit: vi.fn(),
  deliverLaunchPromptToAgentTab: vi.fn(),
  seedNativeChatLaunchDraftForAgentTab: vi.fn(),
  hasMaterializedWebRuntimeBrowserPage: vi.fn()
}))

vi.mock('../store', () => ({
  useAppStore: {
    getState: mocks.getState,
    setState: mocks.setState,
    subscribe: mocks.subscribe
  }
}))

vi.mock('./web-session-tabs-sync/tracking-lifecycle', async (original) => {
  const actual = await original<typeof TrackingLifecycle>()
  return {
    ...actual,
    acceptReplayedWebSessionTabsSnapshot: (
      ...args: Parameters<typeof actual.acceptReplayedWebSessionTabsSnapshot>
    ) =>
      mocks.realStore
        ? actual.acceptReplayedWebSessionTabsSnapshot(...args)
        : mocks.acceptReplayedWebSessionTabsSnapshot(...args)
  }
})
vi.mock('./web-session-tabs-sync/snapshot-api', async (original) => {
  const actual = await original<typeof SnapshotApi>()
  return {
    ...actual,
    applyWebSessionTabsSnapshot: (
      ...args: Parameters<typeof actual.applyWebSessionTabsSnapshot>
    ) =>
      mocks.realStore
        ? actual.applyWebSessionTabsSnapshot(...args)
        : mocks.applyWebSessionTabsSnapshot(...args)
  }
})
vi.mock('./web-session-tabs-sync/tracking-decisions', async (original) => {
  const actual = await original<typeof TrackingDecisions>()
  return {
    ...actual,
    decideWebSessionTabsSnapshot: (
      ...args: Parameters<typeof actual.decideWebSessionTabsSnapshot>
    ) =>
      mocks.realStore
        ? actual.decideWebSessionTabsSnapshot(...args)
        : mocks.decideWebSessionTabsSnapshot(...args)
  }
})
vi.mock('./web-session-tabs-sync/store-patch', async (original) => {
  const actual = await original<typeof StorePatch>()
  return {
    ...actual,
    applyWebSessionTabsStorePatch: (
      ...args: Parameters<typeof actual.applyWebSessionTabsStorePatch>
    ) => {
      if (mocks.realStore) {
        return actual.applyWebSessionTabsStorePatch(...args)
      }
      mocks.setState(args[0])
      return () => {}
    }
  }
})
vi.mock('./web-session-tabs-sync/tracking-mappings', async (original) => {
  const actual = await original<typeof TrackingMappings>()
  return {
    ...actual,
    resolveHostSessionTabIdForWebSessionTab: (
      ...args: Parameters<typeof actual.resolveHostSessionTabIdForWebSessionTab>
    ) =>
      mocks.realStore
        ? actual.resolveHostSessionTabIdForWebSessionTab(...args)
        : mocks.resolveHostSessionTabIdForWebSessionTab(...args)
  }
})

vi.mock('@/lib/feature-education-telemetry', () => ({
  trackTerminalPaneSplit: mocks.trackTerminalPaneSplit
}))

vi.mock('@/lib/agent-launch-prompt-delivery', () => ({
  deliverLaunchPromptToAgentTab: mocks.deliverLaunchPromptToAgentTab,
  seedNativeChatLaunchDraftForAgentTab: mocks.seedNativeChatLaunchDraftForAgentTab
}))

vi.mock('./web-runtime-browser-materialization', () => ({
  hasMaterializedWebRuntimeBrowserPage: mocks.hasMaterializedWebRuntimeBrowserPage
}))

const FOLDER_WORKSPACE_ID = 'folder:fw-1'

type MutableSelection = {
  activeWorktreeId: string | null
  activeWorkspaceExecutionHostId: ExecutionHostId | null
}

// Selection rollback requires a mutable harness store; frozen setActiveWorktree stubs mask the latch.
function stubSelectableWorkspaceStore(selection: MutableSelection): void {
  const base = mocks.getState() as Record<string, unknown>
  mocks.getState.mockImplementation(() => ({ ...base, ...selection }))
  mocks.setActiveWorktree.mockImplementation(
    (worktreeId: string | null, executionHostId?: ExecutionHostId) => {
      selection.activeWorktreeId = worktreeId
      selection.activeWorkspaceExecutionHostId = executionHostId ?? null
      return true
    }
  )
}

afterEach(() => resetWebSessionCloseIntentForTests())

describe('web-runtime-session terminal workspace routing', () => {
  beforeEach(() => {
    resetWebSessionTabsSnapshotFreshnessForTests()
    mocks.realStore = false
    stubTerminalCreateEnvironment(mocks)
  })

  afterEach(() => {
    resetTerminalCreateEnvironment()
  })

  it('does not route a locally-owned workspace to the focused runtime environment', async () => {
    const selection: MutableSelection = {
      activeWorktreeId: WORKTREE_ID,
      activeWorkspaceExecutionHostId: 'local'
    }
    stubSelectableWorkspaceStore(selection)
    const runtimeCall = vi.fn()
    stubRuntimeEnvironmentBridge({ call: runtimeCall })

    // `environmentId: null` is the caller saying "I resolved ownership: nobody remote owns this".
    const outcome = await createWebRuntimeSessionTerminal({
      worktreeId: WORKTREE_ID,
      environmentId: null,
      command: 'powershell.exe',
      activate: true
    })

    expect(outcome.status).toBe('failed')
    expect(runtimeCall).not.toHaveBeenCalled()
    expect(mocks.setActiveWorktree).not.toHaveBeenCalled()
    expect(selection).toEqual({
      activeWorktreeId: WORKTREE_ID,
      activeWorkspaceExecutionHostId: 'local'
    })
  })

  it('does not route a locally-owned folder workspace to the focused runtime environment', async () => {
    const selection: MutableSelection = {
      activeWorktreeId: FOLDER_WORKSPACE_ID,
      activeWorkspaceExecutionHostId: 'local'
    }
    stubSelectableWorkspaceStore(selection)
    const runtimeCall = vi.fn()
    stubRuntimeEnvironmentBridge({ call: runtimeCall })

    const outcome = await createWebRuntimeSessionTerminal({
      worktreeId: FOLDER_WORKSPACE_ID,
      environmentId: null,
      activate: true
    })

    expect(outcome.status).toBe('failed')
    expect(runtimeCall).not.toHaveBeenCalled()
    expect(selection.activeWorkspaceExecutionHostId).toBe('local')
  })

  it('still falls back to the focused environment when the caller expressed no ownership', async () => {
    const selection: MutableSelection = {
      activeWorktreeId: WORKTREE_ID,
      activeWorkspaceExecutionHostId: RUNTIME_EXECUTION_HOST_ID
    }
    stubSelectableWorkspaceStore(selection)
    const runtimeCall = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'create',
        ok: true,
        result: { tab: { id: 'host-tab-1' }, publicationEpoch: 'epoch-1', snapshotVersion: 2 }
      })
      .mockResolvedValueOnce({ id: 'list', ok: true, result: makeSnapshot() })
    stubRuntimeEnvironmentBridge({ call: runtimeCall })

    const outcome = await createWebRuntimeSessionTerminal({
      worktreeId: WORKTREE_ID,
      activate: true
    })

    expect(outcome).toEqual({ status: 'created' })
    expect(runtimeCall.mock.calls[0][0]).toMatchObject({
      selector: ENVIRONMENT_ID,
      method: 'session.tabs.createTerminal'
    })
  })

  it('hands the workspace host selection back when the host never accepted the create', async () => {
    const selection: MutableSelection = {
      activeWorktreeId: WORKTREE_ID,
      activeWorkspaceExecutionHostId: 'local'
    }
    stubSelectableWorkspaceStore(selection)
    const runtimeCall = vi.fn().mockRejectedValue(new Error('selector_not_found'))
    stubRuntimeEnvironmentBridge({ call: runtimeCall })

    const outcome = await createWebRuntimeSessionTerminal({
      worktreeId: WORKTREE_ID,
      environmentId: ENVIRONMENT_ID,
      activate: true
    })

    expect(outcome.status).toBe('failed')
    expect(mocks.setActiveWorktree.mock.calls).toEqual([
      [WORKTREE_ID, RUNTIME_EXECUTION_HOST_ID],
      [WORKTREE_ID, 'local']
    ])
    // The latch is what silently reroutes the next Ctrl+T; it must not survive the failure.
    expect(selection).toEqual({
      activeWorktreeId: WORKTREE_ID,
      activeWorkspaceExecutionHostId: 'local'
    })
  })

  it('keeps the host selection after a create the host accepted', async () => {
    const selection: MutableSelection = {
      activeWorktreeId: WORKTREE_ID,
      activeWorkspaceExecutionHostId: 'local'
    }
    stubSelectableWorkspaceStore(selection)
    const runtimeCall = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'create',
        ok: true,
        result: { tab: { id: 'host-tab-1' }, publicationEpoch: 'epoch-1', snapshotVersion: 2 }
      })
      .mockRejectedValueOnce(new Error('list failed'))
    stubRuntimeEnvironmentBridge({ call: runtimeCall })

    const outcome = await createWebRuntimeSessionTerminal({
      worktreeId: WORKTREE_ID,
      environmentId: ENVIRONMENT_ID,
      activate: true
    })

    expect(outcome).toEqual({ status: 'created' })
    expect(mocks.setActiveWorktree.mock.calls).toEqual([[WORKTREE_ID, RUNTIME_EXECUTION_HOST_ID]])
    expect(selection.activeWorkspaceExecutionHostId).toBe(RUNTIME_EXECUTION_HOST_ID)
  })

  it('leaves a selection the user moved during the failed create alone', async () => {
    const selection: MutableSelection = {
      activeWorktreeId: WORKTREE_ID,
      activeWorkspaceExecutionHostId: 'local'
    }
    stubSelectableWorkspaceStore(selection)
    const runtimeCall = vi.fn().mockImplementation(async () => {
      // The user switched workspaces while the doomed create was in flight.
      selection.activeWorktreeId = 'repo::/other'
      selection.activeWorkspaceExecutionHostId = 'local'
      throw new Error('selector_not_found')
    })
    stubRuntimeEnvironmentBridge({ call: runtimeCall })

    const outcome = await createWebRuntimeSessionTerminal({
      worktreeId: WORKTREE_ID,
      environmentId: ENVIRONMENT_ID,
      activate: true
    })

    expect(outcome.status).toBe('failed')
    expect(mocks.setActiveWorktree.mock.calls).toEqual([[WORKTREE_ID, RUNTIME_EXECUTION_HOST_ID]])
    expect(selection.activeWorktreeId).toBe('repo::/other')
  })

  it('does not touch the host selection when the caller opted out of selecting', async () => {
    const selection: MutableSelection = {
      activeWorktreeId: 'repo::/other',
      activeWorkspaceExecutionHostId: 'local'
    }
    stubSelectableWorkspaceStore(selection)
    const runtimeCall = vi.fn().mockRejectedValue(new Error('selector_not_found'))
    stubRuntimeEnvironmentBridge({ call: runtimeCall })

    await createWebRuntimeSessionTerminal({
      worktreeId: WORKTREE_ID,
      environmentId: ENVIRONMENT_ID,
      selectWorktree: false,
      activate: true
    })

    expect(mocks.setActiveWorktree).not.toHaveBeenCalled()
    expect(selection.activeWorktreeId).toBe('repo::/other')
    expect(selection.activeWorkspaceExecutionHostId).toBe('local')
  })
  it.each(['unchanged', 'create-navigation', 'list-navigation'] as const)(
    'strict paired ordinary create/list/placement respects original caller selection: %s',
    async (action) => {
      mocks.realStore = true
      const store = createTestStore()
      mocks.getState.mockImplementation(store.getState)
      mocks.setState.mockImplementation(store.setState)
      mocks.subscribe.mockImplementation(store.subscribe)
      store.setState({
        activeWorktreeId: WORKTREE_ID,
        activeWorkspaceExecutionHostId: RUNTIME_EXECUTION_HOST_ID
      })
      const sourceId = structuredAgentSessionTabId('codex_source')
      const otherId = structuredAgentSessionTabId('codex_D')
      const destId = toWebTerminalSurfaceTabId('host-destination')
      const leaf = '11111111-1111-4111-8111-111111111111'
      const source = {
        type: 'agent-session' as const,
        id: 'agent-session:codex_source',
        sessionId: 'codex_source',
        agent: 'codex' as const,
        title: 'Source',
        isActive: true
      }
      const other = {
        type: 'agent-session' as const,
        id: 'agent-session:codex_D',
        sessionId: 'codex_D',
        agent: 'codex' as const,
        title: 'D',
        isActive: false
      }
      const destination = {
        type: 'terminal' as const,
        id: `host-destination::${leaf}`,
        parentTabId: 'host-destination',
        leafId: leaf,
        terminal: 'destination-process',
        title: 'Destination',
        status: 'ready' as const,
        isActive: false
      }
      const snapshot = (created: boolean) => ({
        ...makeSnapshot(),
        snapshotVersion: created ? 2 : 1,
        activeTabId: source.id,
        activeTabType: 'agent-session' as const,
        tabs: created ? [source, destination, other] : [source, other],
        tabGroups: [
          {
            id: 'group-1',
            activeTabId: source.id,
            tabOrder: created ? [source.id, 'host-destination', other.id] : [source.id, other.id]
          }
        ]
      })
      store.setState((state) => applyWebSessionTabsSnapshot(state, snapshot(false), ENVIRONMENT_ID))
      store.getState().activateTab(sourceId)
      const original = captureConversationSwitchViewerSelection()
      const created = Promise.withResolvers<void>()
      const listed = Promise.withResolvers<void>()
      const runtimeCall = vi.fn(async (request: { method: string }) => {
        if (request.method === 'session.tabs.createTerminal') {
          await created.promise
          return {
            id: 'create',
            ok: true,
            result: { tab: { id: 'host-destination', leafId: leaf } }
          }
        }
        if (request.method === 'session.tabs.list') {
          await listed.promise
          return { id: 'list', ok: true, result: snapshot(true) }
        }
        throw new Error(`Unexpected external method ${request.method}`)
      })
      stubRuntimeEnvironmentBridge({ call: runtimeCall })
      const running = createWebRuntimeSessionTerminal(
        {
          worktreeId: WORKTREE_ID,
          environmentId: ENVIRONMENT_ID,
          agentSessionKind: 'resume',
          launchAgent: 'codex',
          resumeOrigin: 'switch',
          command: 'codex resume saved',
          providerSession: { key: 'session_id', id: 'saved' },
          afterTabId: sourceId,
          targetGroupId: 'group-1',
          activate: true
        },
        {
          notifyFailure: false,
          canActivate: () => conversationSwitchViewerSelectionCurrent(original)
        }
      )
      await vi.waitFor(() =>
        expect(runtimeCall).toHaveBeenCalledWith(
          expect.objectContaining({
            method: 'session.tabs.createTerminal',
            params: expect.objectContaining({
              activate: false,
              select: false,
              navigation: 'caller'
            })
          })
        )
      )
      if (action === 'create-navigation') {
        store.getState().activateTab(otherId)
      }
      created.resolve()
      await vi.waitFor(() =>
        expect(runtimeCall).toHaveBeenCalledWith(
          expect.objectContaining({ method: 'session.tabs.list' })
        )
      )
      if (action === 'list-navigation') {
        store.getState().activateTab(otherId)
      }
      listed.resolve()
      expect(await running).toEqual({ status: 'created' })
      expect(store.getState().getActiveTab(WORKTREE_ID)?.id).toBe(
        action === 'unchanged' ? destId : otherId
      )
      expect(store.getState().getTab(destId)?.contentType).toBe('terminal')
      expect(store.getState().getTab(sourceId)?.entityId).toBe('codex_source')
    }
  )
})
