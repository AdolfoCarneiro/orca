import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { AgentLaunchPaneVerdict } from '../../../shared/agent-launch-pane-verdict'
import { createTabsSliceMockApi } from '../store/slices/tabs-slice-test-harness'
import { createTestStore } from '../store/slices/store-test-helpers'

// Main's answer to the window's layout commands, as a switch-on build sends them.
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => ({
  ...(await importOriginal<typeof AgentStatusModule>()),
  detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
}))
const testStore = vi.hoisted(() => {
  const ref: { current: ReturnType<typeof createTestStore> | null } = { current: null }
  return ref
})
vi.mock('@/store', () => ({
  useAppStore: {
    setState: (patch: Parameters<ReturnType<typeof createTestStore>['setState']>[0]) => {
      if (!testStore.current) {
        throw new Error('no test store')
      }
      testStore.current.setState(patch)
    },
    getState: () => {
      if (!testStore.current) {
        throw new Error('no test store')
      }
      return testStore.current.getState()
    }
  }
}))
const applyClosedTerminalLeafNotice = vi.hoisted(() => vi.fn())
vi.mock('@/components/terminal-pane/closed-terminal-leaf-notice', () => ({
  applyClosedTerminalLeafNotice
}))

createTabsSliceMockApi()

const { applyAgentLaunchPaneVerdict } = await import('./agent-launch-pane-verdict-application')
const { agentLaunchPanePrompt, rememberAgentLaunchPanePrompt } =
  await import('./agent-launch-pane-prompt')
const { noteAgentLaunchPaneClosedByUser, wasAgentLaunchPaneClosedByUser } =
  await import('./agent-launch-pane-closes')
const { awaitAgentLaunchPaneStart } = await import('./agent-launch-pane-start')
const { agentLaunchPaneOutcomeForLeaf } =
  await import('../components/terminal-pane/agent-launch-pane-notice-text')

const WT = 'repo1::/tmp/feature'
const LEAF = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
let store: ReturnType<typeof createTestStore>
let tabId: string

function launchTab() {
  return store.getState().tabsByWorktree[WT]?.find((tab) => tab.id === tabId)
}

function apply(verdict: AgentLaunchPaneVerdict, leafId = LEAF): void {
  applyAgentLaunchPaneVerdict({ worktreeId: WT, tabId, leafId, operationId: 'op-1', verdict })
}

beforeEach(() => {
  store = createTestStore()
  testStore.current = store
  applyClosedTerminalLeafNotice.mockClear()
  store.getState().setActiveWorktree(WT)
  tabId = store.getState().createTab(WT, undefined, undefined, {
    initialLeafId: LEAF,
    agentLaunchPane: { leafId: LEAF, operationId: 'op-1' }
  }).id
  applyAgentLaunchPaneVerdict({
    worktreeId: WT,
    tabId,
    leafId: LEAF,
    operationId: 'op-1',
    accepted: true,
    verdict: { kind: 'proceed' }
  })
  rememberAgentLaunchPanePrompt(tabId, 'fix the build')
})

describe("a launch pane's verdict in the window", () => {
  it('settled: the tab forgets the launch and its prompt', () => {
    apply({ kind: 'proceed' })
    expect(launchTab()?.agentLaunchPane).toBeUndefined()
    expect(agentLaunchPanePrompt(tabId)).toBeNull()
  })

  it('final: the tab keeps it for this session', () => {
    apply({ kind: 'not-started', code: 'boom' })
    expect(launchTab()?.agentLaunchPane).toEqual({
      leafId: LEAF,
      operationId: 'op-1',
      outcome: { kind: 'not-started', code: 'boom' }
    })
    expect(agentLaunchPanePrompt(tabId)).toBe('fix the build')
  })

  it('unconfirmed: the notice stays until the agent turns up after all', () => {
    apply({ kind: 'unconfirmed' })
    expect(launchTab()?.agentLaunchPane?.outcome).toEqual({ kind: 'unconfirmed' })
    apply({ kind: 'proceed' })
    expect(launchTab()?.agentLaunchPane).toBeUndefined()
  })

  it('final after a user closes the launch leaf does not affect its surviving sibling', async () => {
    const sibling = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'
    const started = awaitAgentLaunchPaneStart(tabId, LEAF)
    // The ordinary split-close owner records the user close before persisting the surviving tree.
    noteAgentLaunchPaneClosedByUser(tabId, LEAF)
    store.getState().setTabLayout(tabId, {
      root: { type: 'leaf', leafId: sibling },
      activeLeafId: sibling,
      expandedLeafId: null
    })
    const layout = store.getState().terminalLayoutsByTabId[tabId]
    await expect(started).resolves.toBeNull()
    expect(wasAgentLaunchPaneClosedByUser(tabId, LEAF)).toBe(true)

    apply({ kind: 'not-started', code: 'agent_launch_tab_closed' })

    expect(store.getState().terminalLayoutsByTabId[tabId]).toBe(layout)
    expect(launchTab()?.agentLaunchPane).toEqual({
      leafId: LEAF,
      operationId: 'op-1',
      outcome: { kind: 'not-started', code: 'agent_launch_tab_closed' }
    })
    expect(agentLaunchPanePrompt(tabId)).toBe('fix the build')
    expect(agentLaunchPaneOutcomeForLeaf(launchTab(), sibling)).toBeNull()
    expect(applyClosedTerminalLeafNotice).not.toHaveBeenCalled()
  })

  it('withdrawn: a tab with only the launch pane goes', () => {
    apply({ kind: 'withdrawn' })
    expect(launchTab()).toBeUndefined()
  })

  it('withdrawn: a split the user added keeps both panes without closing either', () => {
    store.getState().setTabLayout(tabId, {
      root: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', leafId: LEAF },
        second: { type: 'leaf', leafId: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d' }
      },
      activeLeafId: LEAF,
      expandedLeafId: null
    })
    const layout = store.getState().terminalLayoutsByTabId[tabId]
    const tab = launchTab()
    apply({ kind: 'withdrawn' })
    expect(launchTab()).toBe(tab)
    expect(store.getState().terminalLayoutsByTabId[tabId]).toBe(layout)
    expect(agentLaunchPanePrompt(tabId)).toBe('fix the build')
    expect(applyClosedTerminalLeafNotice).not.toHaveBeenCalled()
  })

  it('never touches a pane no launch laid out', () => {
    apply({ kind: 'withdrawn' }, '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d')
    expect(launchTab()).toBeDefined()
    expect(launchTab()?.agentLaunchPane).toEqual({ leafId: LEAF, operationId: 'op-1' })
    expect(agentLaunchPanePrompt(tabId)).toBe('fix the build')
    expect(applyClosedTerminalLeafNotice).not.toHaveBeenCalled()
  })
})

describe('the user closing a launch tab', () => {
  it('is remembered while its agent is starting, so a reveal that raced the close stops it', () => {
    store.getState().closeTab(tabId)
    expect(wasAgentLaunchPaneClosedByUser(tabId, LEAF)).toBe(true)
  })

  it('is not, for a tab whose launch already has its outcome', () => {
    apply({ kind: 'not-started', code: 'boom' })
    store.getState().closeTab(tabId)
    expect(wasAgentLaunchPaneClosedByUser(tabId, LEAF)).toBe(false)
  })
})
