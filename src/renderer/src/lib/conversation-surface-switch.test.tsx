import { structuredAgentSessionTabId } from '../../../shared/structured-agent-session-projection'
// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { applyWebSessionTabsSnapshot } from '@/runtime/web-session-tabs-sync/snapshot-api'
import {
  makeSnapshot,
  resetWebSessionTabsSyncTestState
} from '@/runtime/web-session-tabs-sync-test-harness'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import { createTabsSliceMockApi } from '../store/slices/tabs-slice-test-harness'
import { captureConversationSwitchViewerSelection } from './conversation-switch-selection'
import { publishAgentLaunchTab } from './agent-launch-tab-publication'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { CliChatResumeSource } from '@/components/tab-bar/cli-chat-resume-source'
import type * as SessionOwner from '@/runtime/structured-agent-session-owner'
import { useAppStore } from '@/store'
import { EMPTY_STRUCTURED_AGENT_SESSION } from '../../../shared/structured-agent-session-reducer'
import type { StructuredAgentSessionReadSnapshot } from '@/components/native-chat/structured-agent-session-read-owner-contract'
import {
  runConversationSwitch,
  useConversationSwitchReadiness,
  conversationSwitchFailureText
} from './conversation-surface-switch'
import { pendingNativeChatCliSwitches } from './pending-conversation-surface-switches'

const mocks = vi.hoisted(() => {
  function makeTarget(): { current: RuntimeClientTarget } {
    return { current: { kind: 'local' } }
  }
  return {
    target: makeTarget(),
    support: vi.fn(),
    rpc: vi.fn(),
    capture: vi.fn(),
    prepare: vi.fn(),
    pairedRefresh: vi.fn(),
    call: vi.fn(),
    legacy: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
    error: vi.fn(),
    info: vi.fn(),
    reader: vi.fn(),
    listeners: new Set<() => void>(),
    subscribe: (listener: () => void) => {
      mocks.listeners.add(listener)
      return () => mocks.listeners.delete(listener)
    }
  }
})
vi.mock('sonner', () => ({ toast: { error: mocks.error, info: mocks.info } }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  supportsInPlaceSwitch: mocks.support,
  callStructuredAgentSession: mocks.call
}))
vi.mock('@/runtime/structured-agent-session-owner', async (original) => ({
  ...(await original<typeof SessionOwner>()),
  structuredAgentSessionTargetForHost: () => mocks.target.current
}))
vi.mock('@/runtime/runtime-rpc-client', async (original) => ({
  ...(await original<object>()),
  callRuntimeRpc: mocks.rpc
}))
vi.mock('@/components/tab-bar/cli-chat-resume-terminal-capture', () => ({
  captureSourceTerminal: mocks.capture
}))
vi.mock('./ai-vault-session-resume-preparation', () => ({
  prepareAiVaultSessionForResume: mocks.prepare
}))
vi.mock('@/runtime/web-runtime-session-snapshot', () => ({
  refreshWebRuntimeSessionTabsSnapshot: mocks.pairedRefresh
}))
vi.mock('./in-place-switch-support', () => ({
  useInPlaceSwitchCapability: () => true
}))
vi.mock('@/runtime/structured-agent-session-status-feed', () => ({
  getStructuredAgentSessionStatusFeed: () => ({
    subscribe: mocks.subscribe,
    getSnapshot: () => new Map()
  })
}))
vi.mock('@/components/native-chat/structured-agent-session-read-owner-registry', () => ({
  findStructuredAgentSessionReadOwner: mocks.reader
}))
vi.mock('@/components/tab-bar/cli-chat-resume-run', () => ({
  runLegacyCliChatResume: mocks.legacy
}))
vi.mock('@/components/tab-bar/native-chat-cli-switch-run', () => ({
  runLegacyNativeChatCliSwitch: mocks.legacy
}))
vi.mock('@/components/tab-bar/cli-chat-resume-feedback', () => ({
  switchIntoOwnerLegacy: mocks.legacy
}))
vi.mock('@/runtime/local-structured-session-tabs-sync/inventory-refresh', () => ({
  refreshLocalStructuredSessionWorktreeTabs: mocks.refresh
}))
vi.mock('@/components/right-sidebar/ai-vault-session-resume-in-chat-launch', () => ({
  resumeAiVaultSessionInNewChat: mocks.legacy,
  adoptingAgentOnHost: async (agent: string) => agent
}))

const subject = {
  direction: 'terminal' as const,
  executionHostId: 'local',
  workspaceId: 'workspace',
  sessionId: 'codex_chat',
  agent: 'codex' as const,
  chatTabId: 'source'
}
beforeEach(() => {
  vi.clearAllMocks()
  createTabsSliceMockApi()
  resetWebSessionTabsSyncTestState()
  mocks.target.current = { kind: 'local' }
  mocks.rpc.mockResolvedValue({})
  mocks.pairedRefresh.mockResolvedValue(undefined)
  mocks.capture.mockResolvedValue({
    handle: 'terminal-source',
    incarnationId: 'incarnation',
    presentation: {}
  })
  mocks.reader.mockReturnValue(undefined)
  mocks.support.mockResolvedValue(true)
  mocks.call.mockResolvedValue({ status: 'completed', sessionId: subject.sessionId })
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    settings: { ...useAppStore.getState().settings!, experimentalNativeChat: true }
  })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  pendingNativeChatCliSwitches.clear()
})

it('reserves pending before negotiation, sends one execution request and leaves all launching to the host', async () => {
  const negotiation = Promise.withResolvers<boolean>()
  mocks.support.mockReturnValue(negotiation.promise)
  const first = runConversationSwitch(subject)
  expect(pendingNativeChatCliSwitches.size).toBe(1)
  expect(await runConversationSwitch(subject)).toBe(false)
  negotiation.resolve(true)
  expect(await first).toBe(true)
  expect(mocks.support).toHaveBeenCalledOnce()
  expect(mocks.call).toHaveBeenCalledWith(
    { kind: 'local' },
    'agentSession.switchToTerminal',
    expect.objectContaining({
      sessionId: subject.sessionId,
      execution: expect.objectContaining({ sourceTabId: 'source' })
    }),
    expect.objectContaining({ signal: expect.any(AbortSignal), beforeSend: expect.any(Function) })
  )
  expect(mocks.legacy).not.toHaveBeenCalled()
  expect(pendingNativeChatCliSwitches.size).toBe(0)
})

it('keeps an old peer on the explicit v1 adapter without sending execution fields', async () => {
  mocks.support.mockResolvedValue(false)
  await runConversationSwitch(subject)
  expect(mocks.legacy).toHaveBeenCalledOnce()
  expect(mocks.call).not.toHaveBeenCalled()
})

it('starts the full observer at actual first send, without refilling on later observation', async () => {
  vi.useFakeTimers()
  const answer = Promise.withResolvers<unknown>()
  let send: (() => void) | undefined
  mocks.call.mockImplementation((_target, _method, _params, options) => {
    send = options.beforeSend
    return answer.promise
  })
  const running = runConversationSwitch(subject)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(700_000)
  })
  expect(send).toBeDefined()
  send!()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(40_000)
  })
  expect(pendingNativeChatCliSwitches.size).toBe(1)
  send!()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(695_001)
  })
  expect(await running).toBe(false)
  expect(pendingNativeChatCliSwitches.size).toBe(0)
  answer.resolve({ status: 'completed', sessionId: subject.sessionId })
})

it('clears invocation pending and rereads real state after a lost answer, without hiding a late destination', async () => {
  vi.useFakeTimers()
  const answer = Promise.withResolvers<unknown>()
  mocks.call.mockReturnValue(answer.promise)
  const running = runConversationSwitch(subject)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(735_001)
  })
  expect(await running).toBe(false)
  expect(pendingNativeChatCliSwitches.size).toBe(0)
  expect(mocks.refresh).toHaveBeenCalledWith('workspace', { reacceptCurrentVersion: true })
  expect(mocks.error).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining('could not confirm the Codex switch')
  )
  answer.resolve({ status: 'completed', sessionId: subject.sessionId })
  await Promise.resolve()
  expect(mocks.error).toHaveBeenCalledOnce()
  expect(mocks.legacy).not.toHaveBeenCalled()
})

it.each(['chat', 'terminal'] as const)(
  'uses held live turn facts for %s, without opening a History reader',
  (direction) => {
    let held: StructuredAgentSessionReadSnapshot = {
      current: true,
      loadingOlder: false,
      olderHistoryGeneration: 0,
      state: { ...EMPTY_STRUCTURED_AGENT_SESSION, working: true }
    }
    mocks.reader.mockReturnValue({ subscribe: mocks.subscribe, getSnapshot: () => held })
    const { result } = renderHook(() => useConversationSwitchReadiness({ ...subject, direction }))
    // Owed/unanswered work is decided by the host at click, not by this broad working flag.
    expect(result.current.ready).toBe(true)
    act(() => {
      held = {
        ...held,
        state: {
          ...held.state,
          latestTurn: {
            itemId: 'codex:turn:turn_123',
            observedAt: 1,
            turn: { turnId: 'turn_123', state: 'running' }
          }
        }
      }
      mocks.listeners.forEach((listener) => listener())
    })
    expect(result.current.ready).toBe(true)
    expect(result.current.explanation).toBeUndefined()
    act(() => {
      held = { ...held, current: false }
      mocks.listeners.forEach((listener) => listener())
    })
    expect(result.current.ready).toBe(true)
    expect(mocks.call).not.toHaveBeenCalled()
  }
)

it('keeps suspended and live jobs available for Stop and switch', () => {
  const paneKey = 'terminal:leaf'
  const source = {
    tabId: 'terminal',
    workspaceId: subject.workspaceId,
    paneKey,
    agent: subject.agent,
    providerSessionId: 'provider-session',
    executionHostId: 'local' as const,
    ptyId: 'pty'
  }
  useAppStore.getState().setPaneForegroundAgent(paneKey, {
    agent: null,
    suspendedAgent: 'codex',
    shellForeground: true
  })
  const { result } = renderHook(() =>
    useConversationSwitchReadiness({ ...subject, direction: 'chat', source })
  )
  expect(result.current.ready).toBe(true)
  expect(result.current.explanation).toBeUndefined()
  act(() => {
    useAppStore.getState().setPaneForegroundAgent(paneKey, {
      agent: 'codex',
      shellForeground: false
    })
  })
  expect(result.current.ready).toBe(true)
  expect(result.current.explanation).toBeUndefined()
})

it('formats real refusal categories once, with agent and next step, never raw errors or platform-wrong job control', async () => {
  const text = (reason: string, platform = 'darwin') =>
    conversationSwitchFailureText(null, { ...subject, platform }, reason)
  expect(text('ownerUnproven')).toContain('Check its open chats and terminals')
  expect(text('previousExitUnverifiable')).not.toContain('Restart')
  mocks.call.mockRejectedValue(new Error('secret raw transport/provider failure'))
  await runConversationSwitch({ ...subject, direction: 'chat' })
  expect(mocks.error).toHaveBeenCalledExactlyOnceWith(
    'Codex could not start in chat. Check its setup and try again.'
  )
})

it.each([false, true])(
  'asks once for a live reply; consent=%s has only the authorized effects',
  async (yes) => {
    mocks.reader.mockReturnValue({
      getSnapshot: () => ({
        current: true,
        state: {
          ...EMPTY_STRUCTURED_AGENT_SESSION,
          working: true,
          latestTurn: { itemId: 'turn', observedAt: 1, turn: { turnId: 'turn', state: 'running' } }
        }
      })
    })
    const answer = Promise.withResolvers<boolean>()
    const confirm = vi.fn(() => answer.promise)
    const first = runConversationSwitch({ ...subject, confirm })
    expect(await runConversationSwitch({ ...subject, confirm })).toBe(false)
    expect(confirm).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        title: 'Codex is replying. Stop it and switch?',
        compact: true
      })
    )
    expect(mocks.support).not.toHaveBeenCalled()
    expect(mocks.call).not.toHaveBeenCalled()
    answer.resolve(yes)
    expect(await first).toBe(yes)
    expect(mocks.call).toHaveBeenCalledTimes(yes ? 1 : 0)
    expect(mocks.refresh).toHaveBeenCalledTimes(yes ? 1 : 0)
  }
)

it('does nothing with Chat UI off, including History and direct action dispatch', async () => {
  useAppStore.setState({
    settings: { ...useAppStore.getState().settings!, experimentalNativeChat: false }
  })
  expect(await runConversationSwitch(subject)).toBe(false)
  expect(mocks.support).not.toHaveBeenCalled()
  expect(mocks.call).not.toHaveBeenCalled()
  expect(mocks.refresh).not.toHaveBeenCalled()
})

it.each(['claude', 'codex', 'grok', 'opencode', 'opencode2', 'pi'] as const)(
  'dispatches idle %s once through the common host command, preserving configured commands',
  async (agent) => {
    const confirm = vi.fn()
    useAppStore.setState({
      settings: {
        ...useAppStore.getState().settings!,
        agentCmdOverrides: { [agent]: 'my-alias --option' }
      }
    })
    expect(await runConversationSwitch({ ...subject, agent, confirm })).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
    expect(mocks.call).toHaveBeenCalledExactlyOnceWith(
      { kind: 'local' },
      'agentSession.switchToTerminal',
      expect.objectContaining({
        sessionId: subject.sessionId,
        execution: expect.objectContaining({ commandOverride: 'my-alias --option' })
      }),
      expect.any(Object)
    )
  }
)
it('keeps the disabled agent out of the switch contract', async () => {
  expect(await runConversationSwitch({ ...subject, agent: 'omp' })).toBe(false)
  expect(mocks.call).not.toHaveBeenCalled()
})

it.each(['support', 'Stop'] as const)(
  'uses the original viewer through native %s and real terminal publication',
  async (heldAt) => {
    const source = useAppStore.getState().createUnifiedTab('workspace', 'agent-session', {
      id: 'source',
      entityId: subject.sessionId,
      agentSessionAgent: 'codex'
    })
    const other = useAppStore.getState().createTab('workspace')
    useAppStore.setState({ activeWorktreeId: 'workspace' })
    useAppStore.getState().activateTab(source.id)
    const original = captureConversationSwitchViewerSelection()
    const held = Promise.withResolvers<void>()
    if (heldAt === 'support') {
      mocks.support.mockImplementation(async () => {
        await held.promise
        return true
      })
    }
    mocks.call.mockImplementation(async (_target, _method, request) => {
      if (heldAt === 'Stop') {
        await held.promise
      }
      publishAgentLaunchTab({
        requestId: 'publication',
        tabId: 'destination-terminal',
        leafId: 'destination-leaf',
        worktreeId: 'workspace',
        launchAgent: 'codex',
        viewer: 'focus-in-workspace',
        viewMode: 'terminal',
        viewerSelection: request.execution.viewerSelection
      })
      return { status: 'completed', sessionId: subject.sessionId, terminal: 'destination-terminal' }
    })
    const running = runConversationSwitch(subject)
    if (heldAt === 'Stop') {
      await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
    }
    useAppStore.getState().setActiveTab(other.id)
    held.resolve()
    expect(await running).toBe(true)
    expect(mocks.call.mock.calls[0][2].execution.viewerSelection).toBe(original)
    expect(useAppStore.getState().getActiveTab('workspace')?.id).toBe(other.id)
    expect(
      useAppStore
        .getState()
        .tabsByWorktree.workspace.some((tab) => tab.id === 'destination-terminal')
    ).toBe(true)
  }
)

it.each(['unchanged', 'unchanged-retained', 'prepare-navigation', 'result-navigation'] as const)(
  'paired generated chat request consumes canonical C at the real selection writer: %s',
  async (action) => {
    mocks.target.current = { kind: 'environment', environmentId: 'paired' }
    const host = 'runtime:paired' as const
    const leaf = '11111111-1111-4111-8111-111111111111'
    const source = { id: toWebTerminalSurfaceTabId('host-source') }
    const canonical = {
      id: structuredAgentSessionTabId('codex_canonical-C'),
      entityId: 'codex_canonical-C'
    }
    const other = { id: structuredAgentSessionTabId('codex_D') }
    const canonicalRow = {
      type: 'agent-session' as const,
      id: `agent-session:${canonical.entityId}`,
      sessionId: canonical.entityId,
      agent: 'codex' as const,
      title: 'Canonical',
      isActive: false
    }
    const otherRow = {
      type: 'agent-session' as const,
      id: 'agent-session:codex_D',
      sessionId: 'codex_D',
      agent: 'codex' as const,
      title: 'D',
      isActive: false
    }
    const sourceRow = {
      type: 'terminal' as const,
      id: `host-source::${leaf}`,
      parentTabId: 'host-source',
      leafId: leaf,
      terminal: 'source-process',
      title: 'Source',
      status: 'ready' as const,
      isActive: true
    }
    const snapshot = (retired: boolean) =>
      makeSnapshot(retired ? [canonicalRow, otherRow] : [sourceRow, canonicalRow, otherRow], {
        worktree: 'workspace',
        snapshotVersion: retired ? 2 : 1,
        activeTabId: retired ? canonicalRow.id : sourceRow.id,
        activeTabType: retired ? 'agent-session' : 'terminal',
        tabGroups: [
          {
            id: 'host-group-1',
            activeTabId: retired ? canonicalRow.id : 'host-source',
            tabOrder: retired
              ? [canonicalRow.id, otherRow.id]
              : ['host-source', canonicalRow.id, otherRow.id]
          }
        ]
      })
    useAppStore.setState({ activeWorktreeId: 'workspace', activeWorkspaceExecutionHostId: host })
    useAppStore.setState((state) => applyWebSessionTabsSnapshot(state, snapshot(false), 'paired'))
    useAppStore.getState().activateTab(source.id)
    const original = captureConversationSwitchViewerSelection()
    const preparing = Promise.withResolvers<{
      handle: string
      incarnationId: string
      presentation: object
    }>()
    mocks.capture.mockReturnValue(preparing.promise)
    const listing = Promise.withResolvers<void>()
    mocks.pairedRefresh.mockImplementation(async () => {
      await listing.promise
      useAppStore.setState((state) =>
        applyWebSessionTabsSnapshot(state, snapshot(action !== 'unchanged-retained'), 'paired')
      )
    })
    mocks.call.mockResolvedValue({ status: 'completed', sessionId: canonical.entityId })
    const cli: CliChatResumeSource = {
      agent: 'codex',
      executionHostId: host,
      workspaceId: 'workspace',
      tabId: source.id,
      paneKey: `${source.id}:leaf`,
      ptyId: 'pty',
      providerSessionId: 'saved-conversation'
    }
    const running = runConversationSwitch({
      direction: 'chat',
      executionHostId: host,
      workspaceId: 'workspace',
      agent: 'codex',
      source: cli
    })
    await vi.waitFor(() => expect(mocks.capture).toHaveBeenCalledOnce())
    if (action === 'prepare-navigation') {
      useAppStore.getState().activateTab(other.id)
    }
    preparing.resolve({
      handle: 'original-source',
      incarnationId: 'original-incarnation',
      presentation: {}
    })
    await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
    const request = mocks.call.mock.calls[0][2]
    expect(request.sessionId).not.toBe(canonical.entityId)
    expect(request.execution.create.envelope.sessionId).toBe(request.sessionId)
    expect(request.execution.create.resumeFrom.providerSessionId).toBe(cli.providerSessionId)
    expect(request.execution.viewerSelection).toBe(original)
    await vi.waitFor(() => expect(mocks.pairedRefresh).toHaveBeenCalledOnce())
    if (action === 'result-navigation') {
      useAppStore.getState().activateTab(other.id)
    }
    listing.resolve()
    expect(await running).toBe(true)
    expect(useAppStore.getState().getActiveTab('workspace')?.id).toBe(
      action.startsWith('unchanged') ? canonical.id : other.id
    )
    expect(useAppStore.getState().getTab(canonical.id)?.entityId).toBe(canonical.entityId)
    expect(mocks.rpc).toHaveBeenCalledTimes(action === 'unchanged-retained' ? 1 : 0)
    if (action === 'unchanged-retained') {
      expect(mocks.rpc).toHaveBeenCalledWith(
        mocks.target.current,
        'session.tabs.activate',
        expect.objectContaining({
          tabId: `agent-session:${canonical.entityId}`,
          navigation: 'caller',
          notifyClients: false
        })
      )
    }
  }
)

it.each(['unchanged', 'result-navigation'] as const)(
  'paired terminal result preserves caller selection and readable membership: %s',
  async (action) => {
    mocks.target.current = { kind: 'environment', environmentId: 'paired' }
    const leaf = '11111111-1111-4111-8111-111111111111'
    const sourceId = structuredAgentSessionTabId(subject.sessionId)
    const destination = toWebTerminalSurfaceTabId('host-terminal')
    const other = structuredAgentSessionTabId('codex_D')
    const sourceRow = {
      type: 'agent-session' as const,
      id: `agent-session:${subject.sessionId}`,
      sessionId: subject.sessionId,
      agent: 'codex' as const,
      title: 'Source',
      isActive: true
    }
    const otherRow = {
      type: 'agent-session' as const,
      id: 'agent-session:codex_D',
      sessionId: 'codex_D',
      agent: 'codex' as const,
      title: 'D',
      isActive: false
    }
    const terminalRow = {
      type: 'terminal' as const,
      id: `host-terminal::${leaf}`,
      parentTabId: 'host-terminal',
      leafId: leaf,
      terminal: 'new-process',
      title: 'Destination',
      status: 'ready' as const,
      isActive: false
    }
    const snapshot = (published: boolean) =>
      makeSnapshot(published ? [sourceRow, terminalRow, otherRow] : [sourceRow, otherRow], {
        worktree: 'workspace',
        snapshotVersion: published ? 2 : 1,
        activeTabId: sourceRow.id,
        activeTabType: 'agent-session',
        tabGroups: [
          {
            id: 'host-group-1',
            activeTabId: sourceRow.id,
            tabOrder: published
              ? [sourceRow.id, 'host-terminal', otherRow.id]
              : [sourceRow.id, otherRow.id]
          }
        ]
      })
    useAppStore.setState({
      activeWorktreeId: 'workspace',
      activeWorkspaceExecutionHostId: 'runtime:paired'
    })
    useAppStore.setState((state) => applyWebSessionTabsSnapshot(state, snapshot(false), 'paired'))
    useAppStore.getState().activateTab(sourceId)
    const listed = Promise.withResolvers<void>()
    mocks.pairedRefresh.mockImplementation(async () => {
      await listed.promise
      useAppStore.setState((state) => applyWebSessionTabsSnapshot(state, snapshot(true), 'paired'))
    })
    mocks.call.mockResolvedValue({
      status: 'completed',
      sessionId: subject.sessionId,
      terminal: 'host-terminal',
      sourceRetained: true
    })
    const running = runConversationSwitch({
      ...subject,
      executionHostId: 'runtime:paired',
      chatTabId: sourceId
    })
    await vi.waitFor(() => expect(mocks.pairedRefresh).toHaveBeenCalledOnce())
    if (action === 'result-navigation') {
      useAppStore.getState().activateTab(other)
    }
    listed.resolve()
    expect(await running).toBe(true)
    expect(useAppStore.getState().getActiveTab('workspace')?.id).toBe(
      action === 'unchanged' ? destination : other
    )
    expect(
      useAppStore.getState().tabsByWorktree.workspace.some((tab) => tab.id === destination)
    ).toBe(true)
    expect(mocks.error).not.toHaveBeenCalled()
  }
)
