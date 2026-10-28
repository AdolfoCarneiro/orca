import { captureConversationSwitchViewerSelection } from './conversation-switch-selection'
import type { AppState } from '@/store/types'
import {
  acceptAgentLaunchPaneAttempt,
  awaitAgentLaunchPaneStart,
  settleAgentLaunchPaneStart,
  forgetAgentLaunchPaneAttempts
} from './agent-launch-pane-start'
import { applyAgentLaunchPaneVerdict } from './agent-launch-pane-verdict-application'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  captureSwitchProjection,
  disposeSwitchProjections,
  observeSwitchProjections,
  retireSwitchProjection
} from './conversation-switch-projection'
import {
  isWebSessionCloseIntentPending,
  recordWebSessionCloseIntent
} from '@/runtime/web-session-close-intent'
import { LOCAL_STRUCTURED_SESSION_OWNER } from '@/runtime/local-structured-session-owner'
import { AGENT_SESSION_SWITCH_CLIENT_MS } from '../../../shared/agent-session-switch-execution'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { AgentLaunchTabPublishRequest } from '../../../shared/agent-launch-tab-publication'
import { createTabsSliceMockApi } from '../store/slices/tabs-slice-test-harness'
import { createTestStore } from '../store/slices/store-test-helpers'

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
    setState: (patch: Partial<AppState> | ((state: AppState) => Partial<AppState>)) =>
      testStore.current!.setState(patch),
    getState: () => {
      if (!testStore.current) {
        throw new Error('no test store')
      }
      return testStore.current.getState()
    }
  }
}))
const focusTerminalInitiatedTab = vi.hoisted(() => vi.fn())
vi.mock('@/hooks/ipc-events/terminal-command-state', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  focusTerminalInitiatedTab
}))

createTabsSliceMockApi()

const { publishAgentLaunchTab } = await import('./agent-launch-tab-publication')
const { agentLaunchPanePrompt } = await import('./agent-launch-pane-prompt')

const WT = 'repo1::/tmp/feature'
const OTHER_WT = 'repo1::/tmp/other'
const TAB_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'
const LEAF_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'

let store: ReturnType<typeof createTestStore>

function request(
  overrides: Partial<AgentLaunchTabPublishRequest> = {}
): AgentLaunchTabPublishRequest {
  return {
    requestId: 'request-1',
    worktreeId: WT,
    tabId: TAB_ID,
    leafId: LEAF_ID,
    launchAgent: 'claude',
    viewMode: 'terminal',
    viewer: 'none',
    ...overrides
  }
}

function launchTab() {
  return store.getState().unifiedTabsByWorktree[WT]?.find((tab) => tab.entityId === TAB_ID)
}

beforeEach(() => {
  forgetAgentLaunchPaneAttempts(TAB_ID)
  store = createTestStore()
  testStore.current = store
  focusTerminalInitiatedTab.mockClear()
  store.getState().setActiveWorktree(WT)
})
afterEach(() => disposeSwitchProjections())

describe('publishing a launch tab before its agent exists', () => {
  it('creates the tab under the host ids with its one pane laid out and no process', () => {
    const published = publishAgentLaunchTab(request({ viewMode: 'chat' }))

    expect(published.created).toBe(true)
    expect(published.tabId).toBe(TAB_ID)
    const terminal = store.getState().tabsByWorktree[WT]?.find((tab) => tab.id === TAB_ID)
    // The tab remembers which pane a launch laid out, so after a restart that pane reads the record.
    expect(terminal).toMatchObject({
      ptyId: null,
      launchAgent: 'claude',
      agentLaunchPane: { leafId: LEAF_ID }
    })
    expect(store.getState().terminalLayoutsByTabId[TAB_ID]?.root).toEqual({
      type: 'leaf',
      leafId: LEAF_ID
    })
    expect(launchTab()?.viewMode).toBe('chat')
  })

  it('keeps the prompt for the pane to offer if its agent does not start', () => {
    publishAgentLaunchTab(request({ prompt: 'fix the build' }))
    expect(agentLaunchPanePrompt(TAB_ID)).toBe('fix the build')
  })

  it('never makes a second tab when a retry names the same one', () => {
    publishAgentLaunchTab(request())
    const again = publishAgentLaunchTab(request({ requestId: 'request-2' }))

    expect(again).toMatchObject({ tabId: TAB_ID, created: false })
    expect(store.getState().tabsByWorktree[WT]?.filter((tab) => tab.id === TAB_ID)).toHaveLength(1)
  })

  it("keeps a launch's final outcome on a retry of that launch; a different launch resets it", () => {
    const launchPane = () =>
      store.getState().tabsByWorktree[WT]?.find((tab) => tab.id === TAB_ID)?.agentLaunchPane
    publishAgentLaunchTab(request({ operationId: 'op-1' }))
    store.getState().setTabAgentLaunchPane(TAB_ID, {
      leafId: LEAF_ID,
      operationId: 'op-1',
      outcome: { kind: 'not-started', code: 'boom' }
    })

    publishAgentLaunchTab(request({ requestId: 'request-2', operationId: 'op-1' }))
    expect(launchPane()).toEqual({
      leafId: LEAF_ID,
      operationId: 'op-1',
      outcome: { kind: 'not-started', code: 'boom' }
    })

    publishAgentLaunchTab(request({ requestId: 'request-3', operationId: 'op-2' }))
    expect(launchPane()).toEqual({ leafId: LEAF_ID, operationId: 'op-2' })
  })

  it('never claims a tab it found already shown as one to take back', () => {
    store.getState().createTab(WT, undefined, undefined, {
      id: TAB_ID,
      initialLeafId: LEAF_ID,
      agentLaunchPane: { leafId: LEAF_ID }
    })
    expect(publishAgentLaunchTab(request())).toMatchObject({ tabId: TAB_ID, created: false })
  })

  it("remounts a pane that showed an earlier launch's outcome, so it spawns for the new launch", () => {
    const generation = () =>
      store.getState().tabsByWorktree[WT]?.find((tab) => tab.id === TAB_ID)?.generation ?? 0
    publishAgentLaunchTab(request({ operationId: 'op-1' }))
    // Its spawn was refused: the pane is idle until it remounts.
    store.getState().setTabAgentLaunchPane(TAB_ID, {
      leafId: LEAF_ID,
      operationId: 'op-1',
      outcome: { kind: 'not-started', code: 'boom' }
    })
    const before = generation()

    publishAgentLaunchTab(request({ requestId: 'request-2', operationId: 'op-1' }))
    expect(generation()).toBe(before)

    publishAgentLaunchTab(request({ requestId: 'request-3', operationId: 'op-2' }))
    expect(generation()).toBe(before + 1)
    // A pane still waiting on a launch is spawning already: another launch does not remount it.
    publishAgentLaunchTab(request({ requestId: 'request-4', operationId: 'op-3' }))
    expect(generation()).toBe(before + 1)
  })

  it("refuses a tab id another workspace already uses rather than minting one the agent won't find", () => {
    store.getState().createTab(OTHER_WT, undefined, undefined, { id: TAB_ID })

    expect(() => publishAgentLaunchTab(request())).toThrow('agent_launch_tab_id_taken')
    expect(store.getState().tabsByWorktree[WT] ?? []).toEqual([])
  })
})

describe('placement', () => {
  it('places the destination after a guarded source without retaining it until a user reorders', async () => {
    const source = store.getState().createUnifiedTab(WT, 'agent-session', {
      id: 'source-chat',
      entityId: 'saved-source',
      agentSessionAgent: 'codex'
    })
    const following = store.getState().createTab(WT)
    store.getState().activateTab(source.id)
    const order = () =>
      store.getState().groupsByWorktree[WT]!.find((group) => group.id === source.groupId)!.tabOrder
    expect(order()).toEqual([source.id, following.id])
    const retain = vi.fn()
    captureSwitchProjection(
      store.getState(),
      WT,
      {
        invocationId: 'switch-placement',
        generation: 'switch-generation',
        sessionId: source.entityId,
        tabId: source.id,
        phase: 'prepare'
      },
      retain
    )

    const published = publishAgentLaunchTab(
      request({
        operationId: 'switch-placement',
        launchAgent: 'codex',
        placement: { groupId: source.groupId, afterTabId: source.id }
      })
    )
    expect(published).toMatchObject({ tabId: TAB_ID, created: true })
    expect(launchTab()).toMatchObject({ id: TAB_ID, entityId: TAB_ID, groupId: source.groupId })
    expect(order()).toEqual([source.id, TAB_ID, following.id])
    await Promise.resolve()
    expect(retain).not.toHaveBeenCalled()

    store.getState().reorderUnifiedTabs(source.groupId!, [following.id, source.id, TAB_ID])
    expect(order()).toEqual([following.id, source.id, TAB_ID])
    await Promise.resolve()
    expect(retain).toHaveBeenCalledOnce()
  })

  it('releases retirement on actual use or rollback without clearing a newer close', () => {
    const fixedNow = 1_000_000
    const clock = vi.spyOn(Date, 'now').mockReturnValue(fixedNow)
    try {
      const source = store
        .getState()
        .createUnifiedTab(WT, 'agent-session', { entityId: 'saved-source' })
      const owner = { environmentId: LOCAL_STRUCTURED_SESSION_OWNER }
      const hostTabId = `agent-session:${source.entityId}`
      const pending = (now = fixedNow) => isWebSessionCloseIntentPending(owner, WT, hostTabId, now)
      const proposal = {
        invocationId: 'retirement',
        generation: 'retirement',
        sessionId: source.entityId,
        tabId: source.id,
        phase: 'prepare' as const
      }
      const retiredAt = fixedNow
      captureSwitchProjection(store.getState(), WT, proposal, vi.fn())
      store.setState(retireSwitchProjection(store.getState(), proposal) ?? {})
      expect(store.getState().unifiedTabsByWorktree[WT]).not.toContainEqual(source)
      expect(pending(retiredAt + AGENT_SESSION_SWITCH_CLIENT_MS - 1)).toBe(true)
      store
        .getState()
        .createUnifiedTab(WT, 'agent-session', { id: source.id, entityId: source.entityId })
      store.getState().activateTab(source.id)
      expect(pending()).toBe(false)

      const rollback = { ...proposal, invocationId: 'rollback', generation: 'rollback' }
      captureSwitchProjection(store.getState(), WT, rollback, vi.fn())
      store.setState(retireSwitchProjection(store.getState(), rollback) ?? {})
      expect(pending()).toBe(true)
      observeSwitchProjections(
        store.getState(),
        {
          worktree: WT,
          publicationEpoch: 'rollback',
          snapshotVersion: 1,
          activeGroupId: null,
          activeTabId: null,
          activeTabType: null,
          tabs: [],
          switchProjections: [{ ...rollback, phase: 'retain' }]
        },
        vi.fn()
      )
      expect(pending()).toBe(false)
      recordWebSessionCloseIntent(owner, WT, hostTabId, fixedNow)
      disposeSwitchProjections()
      expect(pending()).toBe(true)
    } finally {
      clock.mockRestore()
    }
  })

  function twoGroups() {
    const anchor = store.getState().createUnifiedTab(WT, 'terminal')
    const sourceGroupId = store.getState().groupsByWorktree[WT]![0]!.id
    const splitGroupId = store.getState().createEmptySplitGroup(WT, sourceGroupId, 'right')!
    return { anchor, sourceGroupId, splitGroupId }
  }

  it('lands in the requested group', () => {
    const { sourceGroupId, splitGroupId } = twoGroups()
    store.getState().focusGroup(WT, sourceGroupId)

    const published = publishAgentLaunchTab(request({ placement: { groupId: splitGroupId } }))

    expect(published.placement).toEqual({ groupId: splitGroupId })
    expect(launchTab()?.groupId).toBe(splitGroupId)
  })

  // Activation prunes empty groups; preserve the CLI launch’s requested split until its tab arrives.
  it.each(
    (['none', 'focus-window', 'focus-in-workspace', 'reveal-owner'] as const).flatMap((viewer) => [
      { viewer, focused: 'split' as const },
      { viewer, focused: 'source' as const }
    ])
  )(
    'lands in a just-created empty split beside a live terminal for a $viewer caller ($focused focused)',
    ({ viewer, focused }) => {
      store.getState().createTab(WT)
      const sourceGroupId = store.getState().groupsByWorktree[WT]![0]!.id
      const splitGroupId = store.getState().createEmptySplitGroup(WT, sourceGroupId, 'right')!
      store.getState().focusGroup(WT, focused === 'split' ? splitGroupId : sourceGroupId)

      const published = publishAgentLaunchTab(
        request({ viewer, placement: { groupId: splitGroupId } })
      )

      expect(published.placement).toEqual({ groupId: splitGroupId })
      expect(launchTab()?.groupId).toBe(splitGroupId)
      expect(store.getState().groupsByWorktree[WT]?.map((group) => group.id)).toContain(
        splitGroupId
      )
    }
  )

  it("falls back to the anchor's group when the requested group is gone", () => {
    const { anchor, sourceGroupId } = twoGroups()

    const published = publishAgentLaunchTab(
      request({ placement: { groupId: 'group-closed', afterTabId: anchor.id } })
    )

    expect(published.placement).toEqual({ groupId: sourceGroupId, fallback: 'anchor-group' })
    const order = store
      .getState()
      .groupsByWorktree[WT]!.find((g) => g.id === sourceGroupId)!.tabOrder
    expect(order.indexOf(launchTab()!.id)).toBe(order.indexOf(anchor.id) + 1)
  })

  it('then to the active group, and the launch still gets its tab', () => {
    const { splitGroupId } = twoGroups()

    const published = publishAgentLaunchTab(request({ placement: { groupId: 'group-closed' } }))

    expect(published.placement).toEqual({ groupId: splitGroupId, fallback: 'active-group' })
    expect(launchTab()?.groupId).toBe(splitGroupId)
  })
})

describe('a focused launch into a workspace with no live terminal', () => {
  it('is the agent starting, not a wake: its first bind moves the workspace up in Recent', () => {
    store.getState().setActiveWorktree(OTHER_WT)
    publishAgentLaunchTab(request({ viewer: 'focus-window' }))
    const tab = store.getState().tabsByWorktree[WT]?.find((candidate) => candidate.id === TAB_ID)
    expect(tab?.pendingActivationSpawn).toBeUndefined()
    expect(tab?.generation).toBeUndefined()

    const epoch = store.getState().sortEpoch
    store.getState().updateTabPtyId(TAB_ID, 'pty-agent-1')

    expect(store.getState().sortEpoch).toBe(epoch + 1)
  })
})

describe('whose view moves', () => {
  it('none: the window stays where it is', () => {
    const before = store.getState().activeTabIdByWorktree[WT]
    store.getState().setActiveWorktree(OTHER_WT)

    publishAgentLaunchTab(request({ viewer: 'none' }))

    expect(store.getState().activeWorktreeId).toBe(OTHER_WT)
    expect(focusTerminalInitiatedTab).not.toHaveBeenCalled()
    expect(store.getState().activeTabIdByWorktree[WT] ?? null).toBe(before ?? TAB_ID)
  })

  it('focus-window: the window goes to the workspace and the tab', () => {
    store.getState().setActiveWorktree(OTHER_WT)

    publishAgentLaunchTab(request({ viewer: 'focus-window' }))

    expect(store.getState().activeWorktreeId).toBe(WT)
    expect(store.getState().activeTabId).toBe(TAB_ID)
    expect(focusTerminalInitiatedTab).toHaveBeenCalledWith(TAB_ID, LEAF_ID, WT)
  })

  it('focus-in-workspace: the desktop stays put when you have moved to another workspace', () => {
    store.getState().setActiveWorktree(OTHER_WT)

    publishAgentLaunchTab(request({ viewer: 'focus-in-workspace' }))

    expect(store.getState().activeWorktreeId).toBe(OTHER_WT)
    expect(store.getState().activeTabIdByWorktree[WT]).toBe(TAB_ID)
    expect(focusTerminalInitiatedTab).not.toHaveBeenCalled()
  })

  it('focus-in-workspace: the tab is focused when you are still there', () => {
    publishAgentLaunchTab(request({ viewer: 'focus-in-workspace' }))

    expect(store.getState().activeWorktreeId).toBe(WT)
    expect(store.getState().activeTabId).toBe(TAB_ID)
    expect(focusTerminalInitiatedTab).toHaveBeenCalledWith(TAB_ID, LEAF_ID, WT)
  })
})

describe('the ordinary window actual verdict producer', () => {
  it('takes back an exact unused failed tab without ordinary Close', () => {
    const shown = publishAgentLaunchTab(request({ operationId: 'A' }))
    expect(
      publishAgentLaunchTab(
        request({ operationId: 'A', withdraw: { root: shown.withdrawalRoot! } })
      ).withdrawn
    ).toBe(true)
    expect(store.getState().tabsByWorktree[WT]?.some((row) => row.id === TAB_ID)).toBe(false)
    expect(store.getState().terminalLayoutsByTabId[TAB_ID]).toBeUndefined()
  })
  it('does not clear a newer accepted/preparing launch prompt or waiter', async () => {
    const shown = publishAgentLaunchTab(request({ operationId: 'A', prompt: 'original' }))
    acceptAgentLaunchPaneAttempt(`${TAB_ID}:${LEAF_ID}`, 'B')
    publishAgentLaunchTab(request({ operationId: 'B', prompt: 'new work' }))
    const started = awaitAgentLaunchPaneStart(TAB_ID, LEAF_ID)
    const answer = vi.fn()
    void started.then(answer)
    expect(
      applyAgentLaunchPaneVerdict({
        worktreeId: WT,
        tabId: TAB_ID,
        leafId: LEAF_ID,
        operationId: 'A',
        withdrawalRoot: shown.withdrawalRoot,
        verdict: { kind: 'withdrawn' }
      })
    ).toBe(false)
    expect(agentLaunchPanePrompt(TAB_ID)).toBe('new work')
    await Promise.resolve()
    expect(answer).not.toHaveBeenCalled()
    settleAgentLaunchPaneStart(TAB_ID, LEAF_ID, 'pty-B')
    expect(await started).toBe('pty-B')
  })
  it('retains a used destination even when the failed start was definitive', () => {
    const shown = publishAgentLaunchTab(request({ operationId: 'A' }))
    store.setState({ lastTerminalInputAtByPaneKey: { [`${TAB_ID}:${LEAF_ID}`]: 1 } })
    const receipt = publishAgentLaunchTab(
      request({ operationId: 'A', withdraw: { root: shown.withdrawalRoot! } })
    )
    expect(receipt.withdrawn).toBe(false)
    expect(store.getState().tabsByWorktree[WT]?.some((row) => row.id === TAB_ID)).toBe(true)
  })
})

it.each(['unchanged', 'navigate', 'close'] as const)(
  'conditions ordinary terminal creation and presentation on the original viewer: %s',
  (action) => {
    const source = store.getState().createTab(WT)
    const other = store.getState().createTab(WT)
    store.getState().setActiveTab(source.id)
    const viewerSelection = captureConversationSwitchViewerSelection()
    if (action === 'navigate') {
      store.getState().setActiveTab(other.id)
    }
    if (action === 'close') {
      store.getState().closeTab(source.id)
    }
    const selected = store.getState().getActiveTab(WT)?.id
    const published = publishAgentLaunchTab(
      request({ viewer: 'focus-in-workspace', viewerSelection })
    )
    expect(published.created).toBe(true)
    expect(launchTab()?.entityId).toBe(TAB_ID)
    expect(store.getState().getActiveTab(WT)?.id).toBe(action === 'unchanged' ? TAB_ID : selected)
    expect(focusTerminalInitiatedTab).toHaveBeenCalledTimes(action === 'unchanged' ? 1 : 0)
  }
)
