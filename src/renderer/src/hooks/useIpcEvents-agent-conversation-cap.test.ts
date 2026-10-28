import { afterEach, expect, it, vi } from 'vitest'
import type { UseBoundStore, StoreApi } from 'zustand'
import type { AppState } from '../store/types'
import type { AgentStatusIpcPayload } from '../../../shared/agent-status-types'
import type { AgentStatusSetData } from './ipc-events-agent-status-store-test-fixtures'
import {
  createTestStore,
  makeTab,
  makeWorktree,
  TEST_REPO
} from '../store/slices/store-test-helpers'
import { buildWindowApi } from './ipc-events-agent-status-window-test-fixtures'
import { collectLeafIds } from '../../../shared/terminal-pane-layout-tree'
import { adoptsCliConversations } from '../../../shared/structured-agent-cli-conversation-adoption'
import {
  collectAgentPaneConversations,
  resolvePaneLastAgentConversation
} from '@/lib/ai-vault-tab-title-requests'
import {
  transferAgentPaneAuthorityAlias,
  resetAgentPaneAuthorityAliasesForTests
} from '../store/slices/agent-pane-authority'
import * as capacity from '../store/slices/agent-status/agent-status-capacity-eviction'
import * as switches from '../lib/pending-conversation-surface-switches'

const mocks = vi.hoisted(() => {
  const store: { current?: UseBoundStore<StoreApi<AppState>> } = {}
  return {
    store,
    support: vi.fn(async () => true),
    call: vi.fn(),
    rpc: vi.fn(),
    launch: vi.fn(),
    toast: vi.fn()
  }
})
vi.mock('@/store', () => ({
  get useAppStore() {
    return mocks.store.current
  }
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  supportsInPlaceSwitch: mocks.support,
  supportsStructuredAgentSessionCliSource: async () => true,
  callStructuredAgentSession: mocks.call
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('@/lib/launch-ai-vault-session', () => ({ launchAiVaultSessionInNewTab: mocks.launch }))
vi.mock('@/runtime/local-runtime-capabilities', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  readLocalRuntimeCapabilitiesOrUnknown: () => [
    'agent-session.structured.v1',
    'agent-session.structured.agents.v1',
    'agent-session.structured.switch.v1:codex'
  ]
}))
vi.mock('@/runtime/host-structured-agents', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  readHostStructuredAgents: () => [{ agent: 'codex', capabilities: {} }]
}))
vi.mock('./agent-hook-completion-notifications', () => ({
  observeAgentHookCompletionForNotification: vi.fn(),
  syncAgentHookCompletionNotificationsForStoreUpdate: vi.fn()
}))
vi.mock('sonner', () => ({ toast: { error: mocks.toast } }))
const cleanup: (() => void)[] = []
afterEach(async () => {
  cleanup
    .splice(0)
    .toReversed()
    .forEach((close) => close())
  resetAgentPaneAuthorityAliasesForTests()
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
const leaf = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const pane = (tab: string, n = 1) => `${tab}:${leaf(n)}`
const layout = (n: number) => ({
  root: { type: 'leaf' as const, leafId: leaf(n) },
  activeLeafId: leaf(n),
  expandedLeafId: null
})
it.each([600, 6000])(
  'bounds real publications across held switches and retries at %i callbacks',
  async (n) => {
    vi.useFakeTimers()
    vi.setSystemTime(1_800_000_000_000)
    vi.clearAllMocks()
    const store = createTestStore()
    mocks.store.current = store
    const tabs = ['cli', 'retry', 'root-b', 'root-c', 'rootless'].map((id) =>
      makeTab({ id, worktreeId: 'wt', createdAt: 1 })
    )
    const roots = [pane('retry'), pane('root-b'), pane('root-c')]
    store.setState({
      workspaceSessionReady: true,
      repos: [TEST_REPO],
      worktreesByRepo: { [TEST_REPO.id]: [makeWorktree({ id: 'wt', repoId: TEST_REPO.id })] },
      tabsByWorktree: { wt: tabs },
      terminalLayoutsByTabId: {
        ...Object.fromEntries(
          tabs.filter((tab) => tab.id !== 'rootless').map((tab) => [tab.id, layout(1)])
        ),
        rootless: { root: null, activeLeafId: null, expandedLeafId: null }
      }
    })
    let onSet: ((data: AgentStatusSetData) => void) | undefined
    vi.stubGlobal(
      'window',
      buildWindowApi({
        onSet: (callback) => {
          onSet = callback
          return () => {}
        }
      })
    )
    const { registerAgentStatusIpcBridge } = await import('./ipc-events/agent-status-ipc-bridge')
    const { resolveCliChatResumeSource } =
      await import('../components/tab-bar/cli-chat-resume-source')
    const unsubs: (() => void)[] = []
    const bridge = registerAgentStatusIpcBridge(unsubs)
    cleanup.push(bridge.disposeAsyncState, bridge.unsubscribeStore, ...unsubs)
    await Promise.resolve()
    let callbacks = 0
    const emit = async (key: string, id = key) => {
      const data: AgentStatusIpcPayload & AgentStatusSetData = {
        paneKey: key,
        state: 'done',
        prompt: '',
        agentType: 'codex',
        providerSessionOnly: true,
        worktreeId: 'wt',
        terminalHandle: `term-${key}`,
        providerSession: { key: 'session_id', id },
        connectionId: null,
        receivedAt: Date.now(),
        stateStartedAt: Date.now()
      }
      if (!onSet) {
        throw new Error('Missing bridge callback')
      }
      onSet(data)
      callbacks += 1
      await vi.advanceTimersByTimeAsync(34)
      expect(store.getState().agentConversationsByPaneKey[key]?.providerSession.id).toBe(id)
      store.getState().clearSleepingAgentSession(key)
    }
    for (const key of [
      pane('cli'),
      ...roots,
      pane('cli', 2),
      pane('retry', 2),
      pane('native'),
      pane('alias-old'),
      pane('alias-new')
    ]) {
      await emit(key, key === pane('cli') || key === pane('retry') ? 'conversation' : key)
    }
    const first = resolveCliChatResumeSource(store.getState(), {
      tab: { id: 'cli', worktreeId: 'wt' },
      paneKey: pane('cli')
    })!
    const retry = resolveCliChatResumeSource(store.getState(), {
      tab: { id: 'retry', worktreeId: 'wt' },
      paneKey: pane('retry')
    })!
    expect(first.providerSessionId).toBe('conversation')
    expect(retry.providerSessionId).toBe('conversation')
    const firstController = new AbortController()
    const retryController = new AbortController()
    switches.pendingCliChatResumes.set(firstController, { key: null, source: first })
    switches.pendingNativeChatCliSwitches.set('native', {
      chatTabId: 'native',
      workspaceId: 'wt',
      executionHostId: 'local'
    })
    cleanup.push(() => {
      switches.pendingCliChatResumes.delete(firstController)
      switches.pendingCliChatResumes.delete(retryController)
      switches.pendingNativeChatCliSwitches.delete('native')
    })
    transferAgentPaneAuthorityAlias({ fromPaneKey: first.paneKey, toPaneKey: pane('alias-old') })
    const { cli: _removed, ...withoutCli } = store.getState().terminalLayoutsByTabId
    store.setState({
      terminalLayoutsByTabId: withoutCli,
      tabsByWorktree: { wt: tabs.filter((tab) => tab.id !== 'cli') }
    })
    switches.pendingCliChatResumes.set(retryController, { key: 'retry', source: retry })
    transferAgentPaneAuthorityAlias({ fromPaneKey: retry.paneKey, toPaneKey: pane('alias-new') })
    let protectedKeys = [
      first.paneKey,
      pane('cli', 2),
      retry.paneKey,
      pane('retry', 2),
      pane('alias-old'),
      pane('alias-new'),
      pane('native')
    ]
    let publications = 0
    const assertBound = () => {
      const state = store.getState()
      const rooted = new Set(
        Object.entries(state.terminalLayoutsByTabId).flatMap(([tab, tree]) =>
          collectLeafIds(tree.root).map((id) => `${tab}:${id}`)
        )
      )
      const keys = Object.keys(state.agentConversationsByPaneKey)
      expect(
        keys.filter((key) => !rooted.has(key) && !protectedKeys.includes(key)).length
      ).toBeLessThanOrEqual(500)
      expect(keys.length).toBeLessThanOrEqual(
        rooted.size + 500 + protectedKeys.filter((key) => !rooted.has(key)).length
      )
      for (const key of [...roots, ...protectedKeys]) {
        expect(state.agentConversationsByPaneKey[key]).toBeDefined()
      }
      publications += 1
    }
    cleanup.push(store.subscribe(assertBound))
    const batches = vi.spyOn(store.getState(), 'transactAgentStatuses')
    const records = vi.spyOn(store.getState(), 'recordAgentProviderSession')
    let classifiedKeys = 0
    let protectionEntries = 0
    const classify = capacity.classifyPaneKeyLiveness
    const protect = switches.protectedConversationPaneKeys
    const classifier = vi.spyOn(capacity, 'classifyPaneKeyLiveness').mockImplementation((state) => {
      const lookup = classify(state)
      return (key) => {
        classifiedKeys += 1
        return lookup(key)
      }
    })
    vi.spyOn(switches, 'protectedConversationPaneKeys').mockImplementation((entries) => {
      protectionEntries += Object.keys(entries).length
      return protect(entries)
    })
    const deliveredBefore = callbacks
    for (let index = 0; index < n; index += 1) {
      await emit(pane(index % 2 ? 'unknown' : 'rootless', index + 10))
    }
    expect(callbacks - deliveredBefore).toBe(n)
    expect(records).toHaveBeenCalledTimes(n)
    expect(batches).toHaveBeenCalledTimes(0)
    expect(publications).toBeGreaterThanOrEqual(n)
    expect(publications).toBeLessThanOrEqual(3 * n)
    expect(classifier.mock.calls.length).toBeLessThanOrEqual(publications)
    expect(classifiedKeys).toBeLessThanOrEqual(510 * publications)
    expect(Object.keys(store.getState().agentConversationsByPaneKey)).toHaveLength(509)
    const oldest = pane(n % 2 ? 'unknown' : 'rootless', n - 500 + 10)
    await emit(oldest, 'replacement-does-not-refresh-residency')
    store.setState(
      {
        ...store.getState(),
        agentConversationsByPaneKey: Object.fromEntries(
          Object.entries(store.getState().agentConversationsByPaneKey).toReversed()
        )
      },
      true
    )
    await emit(pane('unknown', n + 10))
    expect(store.getState().agentConversationsByPaneKey[oldest]).toBeUndefined()
    let nestedWrites = 0
    const stopNested = store.subscribe(() => {
      if (nestedWrites++ === 0) {
        store.setState((state) => ({
          agentConversationsByPaneKey: state.agentConversationsByPaneKey
        }))
      }
    })
    store.setState({ activeWorktreeId: 'wt' })
    stopNested()
    expect(nestedWrites).toBe(2)
    protectedKeys = [retry.paneKey, pane('retry', 2), pane('alias-new'), pane('native')]
    switches.pendingCliChatResumes.delete(firstController)
    store.setState((state) => ({ agentConversationsByPaneKey: state.agentConversationsByPaneKey }))
    expect(Object.keys(store.getState().agentConversationsByPaneKey)).toHaveLength(506)
    expect(store.getState().agentConversationsByPaneKey[pane('alias-new')]).toBeDefined()
    protectedKeys = [pane('native')]
    switches.pendingCliChatResumes.delete(retryController)
    store.setState((state) => ({ agentConversationsByPaneKey: state.agentConversationsByPaneKey }))
    expect(Object.keys(store.getState().agentConversationsByPaneKey)).toHaveLength(504)
    await emit(pane('pressure-after-native-receipt', n + 11))
    protectedKeys = []
    switches.pendingNativeChatCliSwitches.delete('native')
    store.setState((state) => ({ agentConversationsByPaneKey: state.agentConversationsByPaneKey }))
    expect(Object.keys(store.getState().agentConversationsByPaneKey)).toHaveLength(503)
    for (const key of roots) {
      expect(
        resolvePaneLastAgentConversation(
          store.getState(),
          { worktreeId: 'wt', paneKey: key },
          adoptsCliConversations
        )?.providerSession.id
      ).toBe(key === pane('retry') ? 'conversation' : key)
    }
    expect(
      collectAgentPaneConversations(store.getState(), adoptsCliConversations, { allPanes: true })
    ).toEqual(expect.arrayContaining(roots.map((paneKey) => expect.objectContaining({ paneKey }))))
    expect(mocks.rpc.mock.calls.every(([, method]) => method !== 'terminal.close')).toBe(true)
    expect(classifier.mock.calls.length).toBeLessThanOrEqual(publications)
    expect(classifiedKeys).toBeLessThanOrEqual(510 * publications)
    expect(publications).toBeLessThanOrEqual(3 * n + 64)
    console.info('CAP_COUNTS', {
      n,
      callbacks,
      batches: batches.mock.calls.length,
      records: records.mock.calls.length,
      publications,
      classifierBuilds: classifier.mock.calls.length,
      classifiedKeys,
      protectionEntries,
      retained: Object.keys(store.getState().agentConversationsByPaneKey).length
    })
  },
  120_000
)

it.each([600, 6000])(
  'skips retention reconstruction for unchanged identities among %i rooted conversations',
  async (n) => {
    vi.useFakeTimers()
    vi.setSystemTime(1_800_000_000_000)
    const store = createTestStore()
    mocks.store.current = store
    vi.stubGlobal('window', { api: { gh: { enqueuePRRefresh: vi.fn(async () => true) } } })
    const identities = Object.fromEntries(
      Array.from({ length: n }, (_, index) => {
        const paneKey = pane(`root-${index}`)
        return [
          paneKey,
          {
            paneKey,
            worktreeId: 'wt',
            executionHostId: 'local' as const,
            connectionId: null,
            agent: 'codex' as const,
            providerSession: { key: 'session_id' as const, id: `conversation-${index}` }
          }
        ]
      })
    )
    store.setState({
      repos: [TEST_REPO],
      worktreesByRepo: { [TEST_REPO.id]: [makeWorktree({ id: 'wt', repoId: TEST_REPO.id })] },
      tabsByWorktree: { wt: [makeTab({ id: 'root-0', worktreeId: 'wt' })] },
      terminalLayoutsByTabId: Object.fromEntries(
        Array.from({ length: n }, (_, index) => [`root-${index}`, layout(1)])
      ),
      agentConversationsByPaneKey: identities
    })
    const key = pane('root-0')
    let updatedAt = Date.now()
    const status = (state: 'working' | 'done') =>
      store
        .getState()
        .setAgentStatus(
          key,
          { state, agentType: 'codex', prompt: 'Existing conversation' },
          undefined,
          { updatedAt: ++updatedAt },
          { worktreeId: 'wt', connectionId: null },
          { providerSession: identities[key].providerSession }
        )
    status('working')
    const keys = vi.spyOn(Object, 'keys')
    const classifier = vi.spyOn(capacity, 'classifyPaneKeyLiveness')
    const protection = vi.spyOn(switches, 'protectedConversationPaneKeys')
    status('done')
    expect(store.getState().agentStatusByPaneKey[key].state).toBe('done')
    store
      .getState()
      .recordAgentProviderSession(
        key,
        'codex',
        identities[key].providerSession,
        { updatedAt: ++updatedAt },
        { worktreeId: 'wt', connectionId: null }
      )
    expect(store.getState().agentStatusByPaneKey[key]).toBeUndefined()
    store.getState().setAgentStatuses([
      {
        paneKey: key,
        payload: { state: 'working', agentType: 'codex', prompt: 'Next turn' },
        timing: { updatedAt: ++updatedAt },
        routing: { worktreeId: 'wt', connectionId: null },
        metadata: { providerSession: identities[key].providerSession }
      }
    ])
    expect(store.getState().agentStatusByPaneKey[key].state).toBe('working')
    expect(store.getState().agentConversationsByPaneKey).toBe(identities)
    const unchangedEnumerations = keys.mock.calls.filter(([map]) => map === identities).length
    expect(unchangedEnumerations).toBe(0)
    expect(classifier).not.toHaveBeenCalled()
    expect(protection).not.toHaveBeenCalled()
    store
      .getState()
      .recordAgentProviderSession(
        key,
        'codex',
        { key: 'session_id', id: 'replacement' },
        { updatedAt: ++updatedAt },
        { worktreeId: 'wt', connectionId: null }
      )
    expect(store.getState().agentConversationsByPaneKey[key].providerSession.id).toBe('replacement')
    expect(classifier).toHaveBeenCalledTimes(1)
    expect(protection).toHaveBeenCalledTimes(1)
    switches.pendingNativeChatCliSwitches.set('retention-test', {
      chatTabId: 'root-0',
      workspaceId: 'wt',
      executionHostId: 'local'
    })
    cleanup.push(() => switches.pendingNativeChatCliSwitches.delete('retention-test'))
    store.setState({
      terminalLayoutsByTabId: Object.fromEntries(
        Object.entries(store.getState().terminalLayoutsByTabId).slice(501)
      )
    })
    expect(classifier).toHaveBeenCalledTimes(2)
    expect(store.getState().agentConversationsByPaneKey[key]).toBeDefined()
    expect(Object.keys(store.getState().agentConversationsByPaneKey)).toHaveLength(n)
    switches.pendingNativeChatCliSwitches.delete('retention-test')
    store.setState((state) => ({ agentConversationsByPaneKey: state.agentConversationsByPaneKey }))
    expect(classifier).toHaveBeenCalledTimes(3)
    expect(store.getState().agentConversationsByPaneKey[key]).toBeUndefined()
    expect(Object.keys(store.getState().agentConversationsByPaneKey)).toHaveLength(n - 1)
    expect(store.getState().agentConversationsByPaneKey[pane('root-501')]).toBeDefined()
    console.info('UNCHANGED_RETENTION_COUNTS', {
      n,
      acceptedUpdates: 3,
      unchangedEnumerations,
      changedInputRebuilds: classifier.mock.calls.length
    })
    await Promise.resolve()
  }
)
