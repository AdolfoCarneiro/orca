import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { SessionTabOpenPlacement } from '../../../shared/session-tab-placement'
import { captureTerminalSurfaceIdentity } from '../../../shared/terminal-tab-close'
import { structuredAgentSessionTabId } from '../../../shared/structured-agent-session-projection'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import { createTestStore } from '../store/slices/store-test-helpers'
import { createTabsSliceMockApi } from '../store/slices/tabs-slice-test-harness'
import { captureConversationSwitchViewerSelection } from '../lib/conversation-switch-selection'
import { publishAgentLaunchTab } from '../lib/agent-launch-tab-publication'
import { retireTerminalPresentation } from '../components/terminal-pane/terminal-presentation-retirement'
import { applyLocalStructuredSessionTabSnapshots } from './local-structured-session-tabs-sync/snapshot-apply'
import { resetLocalStructuredSessionVersionForTests } from './local-structured-session-tabs-sync/inventory-generation-fence'
import { applyWebSessionTabsSnapshot } from './web-session-tabs-sync/snapshot-api'
import { hostSessionTabIdByLocalKey } from './web-session-tabs-sync/state'
import { resetWebSessionTabsSyncTestState } from './web-session-tabs-sync-test-harness'

const ref = vi.hoisted(() => {
  const current: { store: ReturnType<typeof createTestStore> | null } = { store: null }
  return current
})
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ref.store!.getState(),
    setState: (patch: Partial<AppState>) => ref.store!.setState(patch)
  }
}))
// DOM focus is external I/O; publication, adoption and selection remain production owners.
vi.mock('@/lib/focus-terminal-tab-surface', () => ({ focusTerminalTabSurface: vi.fn() }))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

const api = createTabsSliceMockApi()
const WT = 'placement::workspace'
const OTHER = 'placement::other'
const A = 'source-terminal'
const C = 'neighbour-terminal'
const LEAF = '11111111-1111-4111-8111-111111111111'
const SIBLING = '22222222-2222-4222-8222-222222222222'
const DESTINATION = '33333333-3333-4333-8333-333333333333'
const ENV = 'placement-server'
let store: ReturnType<typeof createTestStore>
let version = 0

function frame(tabs: RuntimeMobileSessionTabsResult['tabs']): RuntimeMobileSessionTabsResult {
  return {
    worktree: WT,
    publicationEpoch: 'placement-host',
    snapshotVersion: ++version,
    activeGroupId: 'host-group',
    activeTabId: null,
    activeTabType: 'terminal',
    tabGroups: [{ id: 'host-group', activeTabId: null, tabOrder: tabs.map((tab) => tab.id) }],
    tabs
  }
}
function terminal(
  id: string
): Extract<RuntimeMobileSessionTabsResult['tabs'][number], { type: 'terminal' }> {
  return {
    type: 'terminal',
    id: `${id}::${LEAF}`,
    parentTabId: id,
    leafId: LEAF,
    title: id,
    isActive: false,
    status: 'ready',
    terminal: `handle-${id}`
  }
}
function apply(snapshot: RuntimeMobileSessionTabsResult, paired: boolean): void {
  store.setState((state) =>
    paired
      ? applyWebSessionTabsSnapshot(state, snapshot, ENV)
      : applyLocalStructuredSessionTabSnapshots(state, [snapshot])
  )
}
function order(): string[] {
  return store.getState().groupsByWorktree[WT]!.flatMap((group) => group.tabOrder)
}
function seed(paired: boolean, extra = false) {
  store.setState({
    activeWorktreeId: WT,
    activeWorkspaceExecutionHostId: paired ? `runtime:${ENV}` : 'local'
  })
  let original: NonNullable<ReturnType<typeof captureTerminalSurfaceIdentity>>
  if (paired) {
    // External host facts; presentation membership is created only by the ordinary mirror writer.
    original = {
      worktreeId: WT,
      tabId: A,
      leafId: LEAF,
      createdAt: 123,
      generation: 0,
      hasLeaf: true,
      ptyId: 'source-host-pty',
      incarnationId: 'source-host-incarnation'
    }
    apply(
      frame([
        { ...terminal(A), ptyId: original.ptyId, incarnationId: original.incarnationId },
        terminal(C)
      ]),
      true
    )
  } else {
    store.getState().createTab(WT, undefined, undefined, { id: A, initialLeafId: LEAF })
    original = captureTerminalSurfaceIdentity(store.getState(), WT, A, LEAF)!
  }
  const a = paired ? toWebTerminalSurfaceTabId(A) : A
  const c = paired ? toWebTerminalSurfaceTabId(C) : C
  const group = store.getState().unifiedTabsByWorktree[WT]!.find((tab) => tab.id === a)!.groupId
  if (!paired) {
    store.getState().createTab(WT, group, undefined, { id: C, initialLeafId: LEAF })
  }
  const editor = (name: string): string => {
    const fileId = store.getState().openFile(
      {
        filePath: `/tmp/placement-${name}.ts`,
        relativePath: `${name}.ts`,
        worktreeId: WT,
        language: 'typescript',
        runtimeEnvironmentId: null,
        mode: 'edit'
      },
      { targetGroupId: group, selection: 'none', suppressActiveRuntimeFallback: true }
    )
    return store.getState().unifiedTabsByWorktree[WT]!.find((tab) => tab.entityId === fileId)!.id
  }
  const b = editor('B')
  const x = extra ? editor('X') : null
  store.getState().reorderUnifiedTabs(group, x ? [a, x, b, c] : [a, b, c])
  store.getState().setActiveTab(a)
  return { group, original, b, x, a, c }
}
function intent(groupId: string, afterTabId?: string): SessionTabOpenPlacement {
  return {
    invocationId: 'switch-invocation',
    generation: 'switch-generation',
    placement: { groupId, afterTabId, index: 0 },
    activate: true,
    viewerSelection: captureConversationSwitchViewerSelection(store.getState())
  }
}
function chat(
  agent: 'claude' | 'codex',
  openPlacement?: SessionTabOpenPlacement
): Extract<RuntimeMobileSessionTabsResult['tabs'][number], { type: 'agent-session' }> {
  return {
    type: 'agent-session',
    id: `agent-session:${agent}-conversation`,
    sessionId: `${agent}-conversation`,
    agent,
    title: agent,
    isActive: false,
    ...(openPlacement ? { openPlacement } : {})
  }
}

beforeEach(() => {
  store = createTestStore()
  ref.store = store
  version = 0
  resetLocalStructuredSessionVersionForTests()
  resetWebSessionTabsSyncTestState()
})
afterEach(() => {
  resetLocalStructuredSessionVersionForTests()
  resetWebSessionTabsSyncTestState()
})

describe('explicit open placement at the actual ordinary store owner', () => {
  it.each([
    ['claude', false],
    ['codex', false],
    ['claude', true],
    ['codex', true]
  ] as const)(
    'keeps the source slot and canonical one-click selection in both directions: %s paired=%s',
    (agent, paired) => {
      const seeded = seed(paired)
      const open = { ...intent(seeded.group, A), source: seeded.original }
      apply(frame([terminal(A), chat(agent, open), terminal(C)]), paired)
      const canonical = structuredAgentSessionTabId(`${agent}-conversation`)
      expect(order()).toEqual([seeded.a, canonical, seeded.b, seeded.c])
      expect(store.getState().getActiveTab(WT)?.entityId).toBe(`${agent}-conversation`)
      if (paired) {
        apply(frame([chat(agent, open), terminal(C)]), true)
      } else {
        retireTerminalPresentation(seeded.original)
      }
      expect(order()).toEqual([canonical, seeded.b, seeded.c])
      const reverse = intent(seeded.group, `agent-session:${agent}-conversation`)
      if (paired) {
        apply(frame([{ ...terminal(DESTINATION), openPlacement: reverse }, terminal(C)]), true)
      } else {
        publishAgentLaunchTab({
          requestId: 'reverse',
          worktreeId: WT,
          tabId: DESTINATION,
          leafId: LEAF,
          launchAgent: agent,
          viewMode: 'terminal',
          viewer: 'focus-in-workspace',
          openPlacement: { ...reverse, placement: { ...reverse.placement, afterTabId: canonical } }
        })
        apply(frame([]), false)
      }
      const destination = paired ? toWebTerminalSurfaceTabId(DESTINATION) : DESTINATION
      expect(order()).toEqual([destination, seeded.b, seeded.c])
      expect(store.getState().getActiveTab(WT)?.id).toBe(destination)
    }
  )

  it('uses the explicit index for a coalesced retired source without moving client-only X or a later used destination', () => {
    const seeded = seed(true, true)
    const open = { ...intent(seeded.group, A), source: seeded.original }
    const snapshot = frame([chat('codex', open), terminal(C)])
    apply(snapshot, true)
    const canonical = structuredAgentSessionTabId('codex-conversation')
    expect(order()).toEqual([canonical, seeded.x, seeded.b, seeded.c])
    store.getState().reorderUnifiedTabs(seeded.group, [seeded.x!, seeded.b, seeded.c, canonical])
    store.getState().activateTab(seeded.b)
    apply({ ...snapshot, snapshotVersion: ++version }, true)
    expect(order()).toEqual([seeded.x!, seeded.b, seeded.c, canonical])
    expect(store.getState().getActiveTab(WT)?.id).toBe(seeded.b)
  })

  it.each([false, true])(
    'selects a source-free History conversation across workspaces and preserves newer navigation: paired=%s',
    (paired) => {
      const seeded = seed(paired)
      store.setState({ activeWorktreeId: OTHER, activeTabId: null, activeTabType: 'terminal' })
      const open = intent(seeded.group)
      apply(frame([terminal(A), terminal(C), chat('codex', open)]), paired)
      expect(store.getState().activeWorktreeId).toBe(WT)
      expect(store.getState().activeTabType).toBe('agent-session')
      expect(store.getState().getActiveTab(WT)?.entityId).toBe('codex-conversation')
      const stale = intent(seeded.group)
      store.setState({ activeWorktreeId: OTHER })
      apply(frame([terminal(A), terminal(C), chat('claude', stale), chat('codex', open)]), paired)
      expect(store.getState().activeWorktreeId).toBe(OTHER)
      expect(store.getState().getActiveTab(WT)?.entityId).toBe('codex-conversation')
    }
  )

  it.each(['publication-first', 'inventory-first'] as const)(
    'keeps first terminal materialization placed across both ordinary arrival orders: %s',
    (arrival) => {
      const seeded = seed(false)
      const open = intent(seeded.group, A)
      const publish = () =>
        publishAgentLaunchTab({
          requestId: 'terminal-open',
          worktreeId: WT,
          tabId: DESTINATION,
          leafId: LEAF,
          launchAgent: 'codex',
          viewMode: 'terminal',
          viewer: 'focus-in-workspace',
          openPlacement: open
        })
      const snapshot = frame([
        { ...terminal(DESTINATION), openPlacement: open },
        terminal(A),
        terminal(C)
      ])
      const observed: string[][] = []
      const stop = store.subscribe(() => {
        const ids = order()
        if (ids.includes(DESTINATION) || ids.includes(toWebTerminalSurfaceTabId(DESTINATION))) {
          observed.push(ids)
        }
      })
      if (arrival === 'publication-first') {
        publish()
        apply(snapshot, false)
      } else {
        apply(snapshot, false)
        publish()
      }
      stop()
      expect(observed.length).toBeGreaterThan(0)
      for (const ids of observed) {
        expect(
          ids.findIndex((id) => id === DESTINATION || id === toWebTerminalSurfaceTabId(DESTINATION))
        ).toBe(1)
      }
      expect(order()).toHaveLength(4)
    }
  )

  it.each(['reused', 'closed', 'split'] as const)(
    'retains exact source/sibling authority during placement: %s',
    (change) => {
      const seeded = seed(false)
      const open = { ...intent(seeded.group, A), source: seeded.original }
      if (change === 'reused') {
        store.setState((state) => ({
          tabsByWorktree: {
            ...state.tabsByWorktree,
            [WT]: state.tabsByWorktree[WT]!.map((row) =>
              row.id === A ? { ...row, generation: 1 } : row
            )
          }
        }))
      } else if (change === 'closed') {
        store.getState().closeTab(A)
      } else {
        store.getState().setTabLayout(A, {
          root: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', leafId: LEAF },
            second: { type: 'leaf', leafId: SIBLING }
          },
          activeLeafId: SIBLING,
          expandedLeafId: null,
          ptyIdsByLeafId: { [SIBLING]: 'sibling-pty' }
        })
      }
      api.pty.kill.mockClear()
      apply(frame([chat('claude', open)]), false)
      const canonical = structuredAgentSessionTabId('claude-conversation')
      if (change === 'split') {
        expect(order()).toEqual([A, canonical, seeded.b, C])
        retireTerminalPresentation(seeded.original)
        expect(store.getState().terminalLayoutsByTabId[A]?.root).toEqual({
          type: 'leaf',
          leafId: SIBLING
        })
        expect(store.getState().terminalLayoutsByTabId[A]?.ptyIdsByLeafId).toEqual({
          [SIBLING]: 'sibling-pty'
        })
        expect(order()).toEqual([A, canonical, seeded.b, C])
      } else {
        expect(order().at(-1)).toBe(canonical)
      }
      expect(api.pty.kill).not.toHaveBeenCalled()
    }
  )

  it('preserves first canonical identity and ordered duplicate replacement candidates in ordinary adoption', () => {
    store.setState({ activeWorktreeId: WT })
    const first = store.getState().createUnifiedTab(WT, 'agent-session', {
      id: 'old-first',
      entityId: 'old-conversation',
      agentSessionAgent: 'codex'
    })
    const second = store.getState().createUnifiedTab(WT, 'agent-session', {
      id: 'old-second',
      entityId: 'old-conversation',
      agentSessionAgent: 'codex'
    })
    const canonical = store.getState().createUnifiedTab(WT, 'agent-session', {
      id: 'canonical-first',
      entityId: 'canonical-conversation',
      agentSessionAgent: 'codex'
    })
    store.getState().createUnifiedTab(WT, 'agent-session', {
      id: 'canonical-duplicate',
      entityId: 'canonical-conversation',
      agentSessionAgent: 'codex'
    })
    apply(
      frame([
        {
          ...chat('codex'),
          id: 'host-canonical',
          sessionId: 'canonical-conversation',
          replacesSessionId: 'old-conversation'
        },
        {
          ...chat('claude'),
          id: 'host-new-first',
          sessionId: 'new-first',
          replacesSessionId: 'old-conversation'
        },
        {
          ...chat('codex'),
          id: 'host-new-second',
          sessionId: 'new-second',
          replacesSessionId: 'old-conversation'
        }
      ]),
      true
    )
    const rows = store.getState().unifiedTabsByWorktree[WT]!
    expect(
      rows.filter((row) => row.entityId === 'canonical-conversation').map((row) => row.id)
    ).toEqual([canonical.id])
    expect(rows.find((row) => row.entityId === 'new-first')).toMatchObject({
      id: first.id,
      groupId: first.groupId
    })
    expect(rows.find((row) => row.entityId === 'new-second')).toMatchObject({
      id: second.id,
      groupId: second.groupId
    })
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length)
  })

  it.each([false, true])(
    'bounds retained source-absent snapshot replay work at N/10N: paired=%s',
    (paired) => {
      const measure = (count: number) => {
        store = createTestStore()
        ref.store = store
        resetLocalStructuredSessionVersionForTests()
        resetWebSessionTabsSyncTestState()
        store.setState({
          activeWorktreeId: WT,
          activeWorkspaceExecutionHostId: paired ? `runtime:${ENV}` : 'local',
          worktreeNavHistory: Array.from({ length: 50 }, (_, i) => `history-${i}`),
          worktreeNavHistoryIndex: 49
        })
        const sourceIds = Array.from({ length: count }, (_, i) => `retired-source-${i}`)
        if (paired) {
          apply(frame(sourceIds.map(terminal)), true)
        } else {
          for (const id of sourceIds) {
            store.getState().createTab(WT, undefined, undefined, { id, initialLeafId: LEAF })
          }
        }
        const group = store.getState().groupsByWorktree[WT]![0]!.id
        const captured = sourceIds.map((id) =>
          captureTerminalSurfaceIdentity(
            store.getState(),
            WT,
            paired ? toWebTerminalSurfaceTabId(id) : id,
            LEAF
          )!
        )
        const viewerSelection = captureConversationSwitchViewerSelection(store.getState())
        const destinations = sourceIds.map((sourceId, i) => ({
          ...chat(i % 2 ? 'claude' : 'codex'),
          id: `agent-session:retained-${i}`,
          sessionId: `retained-${i}`,
          openPlacement: {
            ...intent(group, sourceId),
            viewerSelection,
            invocationId: `retained-${i}`,
            generation: `generation-${i}`,
            source: { ...captured[i]!, tabId: sourceId }
          }
        }))
        apply(frame([...sourceIds.map(terminal), ...destinations]), paired)
        if (paired) {
          apply(frame(destinations), true)
        } else {
          for (const original of captured) {
            retireTerminalPresentation(original)
          }
        }
        expect(store.getState().tabsByWorktree[WT]).toHaveLength(0)
        const before = store.getState()
        const beforeOrder = order()
        const beforeActiveId = before.getActiveTab(WT)?.id
        let tabReads = 0
        let historyReads = 0
        store.setState({
          unifiedTabsByWorktree: {
            ...before.unifiedTabsByWorktree,
            [WT]: before.unifiedTabsByWorktree[WT]!.map(
              (row) =>
                new Proxy(row, {
                  get: (target, key, receiver) => {
                    if (key === 'id' || key === 'entityId' || key === 'contentType') {
                      tabReads++
                    }
                    // oxlint-disable-next-line anti-slop/no-reflect-get -- Proxy `get` trap: only Reflect.get forwards a raw string|symbol key with the proxy receiver.
                    return Reflect.get(target, key, receiver)
                  }
                })
            )
          },
          worktreeNavHistory: new Proxy(before.worktreeNavHistory, {
            get: (target, key, receiver) => {
              if (typeof key === 'string' && /^\d+$/.test(key)) {
                historyReads++
              }
              // oxlint-disable-next-line anti-slop/no-reflect-get -- Proxy `get` trap: only Reflect.get forwards a raw string|symbol key with the proxy receiver.
              return Reflect.get(target, key, receiver)
            }
          })
        })
        const mappings = vi.spyOn(hostSessionTabIdByLocalKey, 'get')
        try {
          apply(frame(destinations), paired)
          const mappingReads = mappings.mock.calls.length
          const membershipReads = tabReads
          expect(order()).toEqual(beforeOrder)
          expect(store.getState().getActiveTab(WT)?.id).toBe(beforeActiveId)
          expect(store.getState().activeWorktreeId).toBe(before.activeWorktreeId)
          expect(order()).toHaveLength(count)
          expect(historyReads).toBeGreaterThan(0)
          expect(historyReads).toBeLessThanOrEqual(100)
          expect(mappingReads).toBeLessThanOrEqual(30 * count + 300)
          expect(membershipReads).toBeGreaterThan(0)
          expect(membershipReads).toBeLessThanOrEqual(50 * count + 500)
          return { count, mappingReads, membershipReads, historyReads }
        } finally {
          mappings.mockRestore()
        }
      }
      const small = measure(10)
      const large = measure(100)
      expect(large.mappingReads).toBeLessThanOrEqual(12 * Math.max(1, small.mappingReads))
      expect(large.membershipReads).toBeLessThanOrEqual(12 * small.membershipReads)
      expect(large.historyReads).toBeLessThanOrEqual(2 * small.historyReads)
      process.stdout.write(
        `retained snapshot operation counts ${JSON.stringify({ paired, small, large })}\n`
      )
    }
  )

  it('retains the ordinary append and unsolicited-selection policy without placement metadata', () => {
    const seeded = seed(false)
    apply(frame([chat('claude')]), false)
    expect(order()).toEqual([A, seeded.b, C, structuredAgentSessionTabId('claude-conversation')])
    expect(store.getState().getActiveTab(WT)?.id).toBe(A)
  })
})
