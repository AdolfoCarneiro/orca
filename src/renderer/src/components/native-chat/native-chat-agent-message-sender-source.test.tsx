// @vitest-environment happy-dom
import { act, cleanup, render, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import { readStoreListenerCount } from '@/store/store-listener-census'
import { makeTab, makeWorktree, TEST_REPO } from '@/store/slices/store-test-helpers'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status-types'
import type { AgentMessageSenderView } from '../../../../shared/agent-session/agent-message-presentation'
import { useAgentMessageSenderSource } from './native-chat-agent-message-sender-source'
import { useAgentMessageSenderView } from './native-chat-agent-message-sender-view'
import * as selectors from '@/components/sidebar/worktree-agent-row-selectors'
import * as rows from '@/components/sidebar/worktree-agent-rows'
import * as cache from '@/components/dashboard/worktree-agent-rows-cache'
import * as structuredOwner from '@/runtime/structured-agent-session-owner'
import * as owners from '@/lib/worktree-runtime-owner'
import * as freshness from '@/components/sidebar/worktree-agent-freshness-selector'
import * as senderLocation from './native-chat-agent-message-sender-label'
import * as presentation from '@/lib/program-status/agent-row-presentation'
import * as inputs from '@/components/sidebar/worktree-card-status-inputs'
import { runtimeEnvironmentStatusFromSnapshot } from '../../../../shared/runtime-host-status'
import { AgentStateDot } from '@/components/AgentStateDot'

type SenderPopulation = AppState[
  | 'agentStatusByPaneKey'
  | 'retainedAgentsByPaneKey'
  | 'migrationUnsupportedByPtyId'
  | 'runtimeAgentOrchestrationByPaneKey']
const initial = useAppStore.getState()
const LEAF = '11111111-1111-4111-8111-111111111111'
const renders = new Map<number, number>()
const views = new Map<number, AgentMessageSenderView>()
function status(i: number, worktreeId = 'workspace'): AgentStatusEntry {
  return {
    paneKey: `tab-${i}:${LEAF}`,
    worktreeId,
    terminalHandle: `term_${i}`,
    agentType: 'claude',
    state: 'working',
    prompt: 'work',
    updatedAt: 2_000_000,
    stateStartedAt: 2_000_000,
    stateHistory: []
  }
}
function Probe({
  id,
  sender = 0,
  workspace = 'workspace',
  remote = false
}: {
  id: number
  sender?: number
  workspace?: string
  remote?: boolean
}) {
  const value = useAgentMessageSenderView(
    {
      party: { address: `term_${sender}`, terminalHandle: `term_${sender}`, orcaSessionId: null },
      name: 'Sender'
    },
    workspace,
    remote ? { kind: 'environment', environmentId: 'remote' } : { kind: 'local' }
  )
  renders.set(id, (renders.get(id) ?? 0) + 1)
  views.set(id, value)
  return null
}
function populate(n: number) {
  useAppStore.setState({
    activeWorktreeId: 'workspace',
    activeWorkspaceExecutionHostId: 'local',
    tabsByWorktree: {
      workspace: Array.from({ length: n }, (_, i) =>
        makeTab({ id: `tab-${i}`, worktreeId: 'workspace', sortOrder: i })
      )
    },
    unifiedTabsByWorktree: {},
    agentStatusByPaneKey: Object.fromEntries(
      Array.from({ length: n }, (_, i) => {
        const entry = status(i)
        return [entry.paneKey, entry]
      })
    ),
    retainedAgentsByPaneKey: {},
    migrationUnsupportedByPtyId: {},
    runtimePaneTitlesByTabId: {},
    ptyIdsByTabId: {},
    terminalLayoutsByTabId: {},
    runtimeAgentOrchestrationByPaneKey: {},
    paneForegroundAgentByPaneKey: {},
    agentStatusEpoch: 1
  })
}
function write(i: number, update: Partial<AgentStatusEntry>) {
  const state = useAppStore.getState()
  const key = status(i).paneKey
  act(() =>
    useAppStore.setState({
      agentStatusByPaneKey: {
        ...state.agentStatusByPaneKey,
        [key]: { ...state.agentStatusByPaneKey[key], ...update }
      },
      agentStatusEpoch: state.agentStatusEpoch + 1
    })
  )
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(2_000_000)
  renders.clear()
  views.clear()
  populate(3)
})
afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it('isolates local/remote selected consumers and owns sources through metadata, decay, retention and removal', () => {
  const baseline = readStoreListenerCount()
  const other = status(9, 'remote')
  useAppStore.setState({
    repos: [TEST_REPO],
    worktreesByRepo: {
      [TEST_REPO.id]: [
        makeWorktree({ id: 'remote', repoId: TEST_REPO.id, hostId: 'runtime:remote' })
      ]
    },
    tabsByWorktree: {
      ...useAppStore.getState().tabsByWorktree,
      remote: [makeTab({ id: 'tab-9', worktreeId: 'remote' })]
    },
    agentStatusByPaneKey: { ...useAppStore.getState().agentStatusByPaneKey, [other.paneKey]: other }
  })
  const build = vi.spyOn(rows, 'buildWorktreeAgentRows')
  const create = vi.spyOn(cache, 'createWorktreeAgentRowsCache')
  const store = useAppStore.getState()
  store.setAgentProgramStatus(status(1).paneKey, {
    state: 'working',
    progress: 40,
    observedAt: 2_000_000
  })
  const mounted = render(
    <>
      <Probe id={0} />
      <Probe id={1} />
      <Probe id={2} sender={1} />
      <Probe id={3} sender={9} workspace="remote" remote />
    </>
  )
  expect(create).toHaveBeenCalledTimes(2)
  expect(build).toHaveBeenCalledTimes(2)
  expect(views.get(3)?.dot).toBe('working')
  expect(views.get(2)?.progress).toBe(40)
  let before = new Map(renders)
  const epoch = useAppStore.getState().agentStatusEpoch
  act(() => {
    store.setAgentProgramStatus(status(1).paneKey, {
      state: 'working',
      progress: 60,
      observedAt: 2_000_000
    })
  })
  expect(useAppStore.getState().agentStatusEpoch).toBe(epoch)
  expect(views.get(2)?.progress).toBe(60)
  expect(renders.get(2)).toBe(before.get(2)! + 1)
  for (const id of [0, 1, 3]) {
    expect(renders.get(id)).toBe(before.get(id))
  }
  before = new Map(renders)
  act(() => {
    expect(
      store.setAgentProgramStatus(status(1).paneKey, {
        state: 'working',
        progress: 60,
        observedAt: 2_000_001
      })
    ).toBe(false)
  })
  act(() => {
    store.setAgentProgramStatus(status(1).paneKey, {
      state: 'working',
      progress: 60,
      message: 'detail',
      observedAt: 2_000_002
    })
  })
  expect(renders).toEqual(before)
  build.mockClear()
  write(0, { state: 'blocked' })
  expect(build.mock.calls.map(([args]) => args.tabs[0]?.worktreeId)).toEqual(['workspace'])
  for (const id of [0, 1]) {
    expect(renders.get(id)).toBe(before.get(id)! + 1)
  }
  for (const id of [2, 3]) {
    expect(renders.get(id)).toBe(before.get(id))
  }
  before = new Map(renders)
  build.mockClear()
  act(() =>
    useAppStore.setState({
      agentStatusByPaneKey: {
        ...useAppStore.getState().agentStatusByPaneKey,
        [other.paneKey]: { ...other, state: 'waiting' }
      },
      agentStatusEpoch: useAppStore.getState().agentStatusEpoch + 1
    })
  )
  expect(build.mock.calls.map(([args]) => args.tabs[0]?.worktreeId)).toEqual(['remote'])
  expect(views.get(3)?.dot).toBe('waiting')
  expect(renders.get(3)).toBe(before.get(3)! + 1)
  for (const id of [0, 1, 2]) {
    expect(renders.get(id)).toBe(before.get(id))
  }
  const disconnected = runtimeEnvironmentStatusFromSnapshot({
    environmentId: 'remote',
    pairingRevision: 1,
    sequence: 1,
    checkedAt: 1,
    verification: 'blocked',
    transport: 'disconnected',
    retired: true,
    status: null
  })
  act(() =>
    useAppStore.setState({ runtimeStatusByEnvironmentId: new Map([['remote', disconnected]]) })
  )
  build.mockClear()
  before = new Map(renders)
  act(() => useAppStore.setState({ sidebarBody: 'agents' }))
  expect(build).not.toHaveBeenCalled()
  expect(renders).toEqual(before)
  expect(create).toHaveBeenCalledTimes(2)
  for (let i = 0; i < 3; i++) {
    write(0, { prompt: `publication-${i}` })
    for (const result of create.mock.results) {
      if (result.type === 'return') {
        expect(result.value.byWorktree.size).toBe(1)
        expect(result.value.lastComputedWorktreeIds.length).toBeLessThanOrEqual(1)
        expect(result.value.seenWorktreeIds.size).toBe(1)
      }
    }
  }
  act(() => useAppStore.setState({ activeWorkspaceExecutionHostId: 'runtime:remote' }))
  expect(views.get(0)).toEqual({})
  act(() => useAppStore.setState({ activeWorkspaceExecutionHostId: 'local' }))
  expect(views.get(0)?.dot).toBe('blocked')
  write(0, {
    agentType: 'codex',
    state: 'working',
    programStatus: { state: 'blocked', progress: 60, observedAt: 2_000_000 }
  })
  expect(views.get(0)).toEqual({ agentType: 'codex', dot: 'permission', progress: 60 })
  act(() => {
    store.setAgentProgramStatus(status(0).paneKey, null)
  })
  expect(views.get(0)?.dot).toBe('working')
  vi.setSystemTime(2_000_000 + AGENT_STATUS_STALE_AFTER_MS + 1)
  act(() => useAppStore.setState({ agentStatusEpoch: useAppStore.getState().agentStatusEpoch + 1 }))
  expect(views.get(0)?.dot).not.toBe('working')
  const entry = {
    ...status(0),
    state: 'done' as const,
    programStatus: { state: 'working' as const, progress: 60, observedAt: 2_000_000 }
  }
  act(() =>
    useAppStore.setState({
      agentStatusByPaneKey: {},
      retainedAgentsByPaneKey: {
        [entry.paneKey]: {
          entry,
          tab: makeTab({ id: 'tab-0', worktreeId: 'workspace' }),
          worktreeId: 'workspace',
          agentType: 'claude',
          startedAt: 1
        }
      }
    })
  )
  expect(views.get(0)).toEqual({ agentType: 'claude', dot: 'done', progress: undefined })
  mounted.rerender(<Probe id={0} sender={2} />)
  expect(views.get(0)).toEqual({})
  mounted.unmount()
  expect(readStoreListenerCount()).toBe(baseline)
  for (const result of create.mock.results) {
    if (result.type === 'return') {
      expect(result.value.byWorktree.size).toBe(0)
      expect(result.value.lastComputedWorktreeIds).toEqual([])
      expect(result.value.seenWorktreeIds.size).toBe(0)
    }
  }
  const count = create.mock.calls.length
  render(<Probe id={0} />)
  expect(create.mock.calls.length).toBeGreaterThan(count)
  expect(views.get(0)?.dot).toBe('done')
  expect(views.get(0)?.progress).toBeUndefined()
})

it.each([100, 1000])(
  'bounds actual publication work separately from renders at %i rows/cards',
  (n) => {
    populate(n)
    const settings = createGlobalSettingsFixture()
    useAppStore.setState({ settings })
    let entries = 0,
      freshnessVisits = 0,
      preProjectorStatusValueVisits = 0
    const population = new Map<SenderPopulation, { calls: number; entries: number }>()
    let projecting = false
    const projector = cache.selectWorktreeAgentRowsCached
    const projections = vi
      .spyOn(cache, 'selectWorktreeAgentRowsCached')
      .mockImplementation((args) => {
        projecting = true
        try {
          return projector(args)
        } finally {
          projecting = false
        }
      })
    const values = Object.values
    vi.spyOn(Object, 'values').mockImplementation((object: SenderPopulation) => {
      const result = values(object)
      const metric = population.get(object)
      if (metric) {
        metric.calls++
        metric.entries += result.length
      }
      const state = useAppStore.getState()
      if (
        !projecting &&
        (object === state.agentStatusByPaneKey || object === state.retainedAgentsByPaneKey)
      ) {
        preProjectorStatusValueVisits += result.length
      }
      return result
    })
    let fresh = false
    const originalFreshness = freshness.createWorktreeAgentFreshnessSelector
    vi.spyOn(freshness, 'createWorktreeAgentFreshnessSelector').mockImplementation((...args) => {
      const select = originalFreshness(...args)
      return (state) => {
        fresh = true
        try {
          return select(state)
        } finally {
          fresh = false
        }
      }
    })
    const arrays = new WeakMap<AgentStatusEntry[], AgentStatusEntry[]>()
    const recordWork = new Map<string, { source: number }>()
    function recordProbe<Source extends object>(name: string) {
      const metric = { source: 0 }
      recordWork.set(name, metric)
      return {
        source(record: Source): Source {
          return new Proxy(record, {
            get(target, key) {
              if (typeof key === 'string') {
                metric.source++
              }
              // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: plain fixture data has no accessor overrides; methods retain the caller's proxy receiver and indexed reads remain counted.
              return target[key as keyof typeof target]
            }
          })
        }
      }
    }
    const titles =
      recordProbe<ReturnType<typeof inputs.selectRuntimePaneTitlesForWorktree>>('titles')
    const ptys = recordProbe<ReturnType<typeof inputs.selectLivePtyIdsForWorktree>>('ptys')
    const layouts = recordProbe<AppState['terminalLayoutsByTabId']>('layouts')
    const foreground =
      recordProbe<ReturnType<typeof inputs.selectPaneForegroundAgentsForWorktree>>('foreground')
    const recordSelectors = [
      vi.spyOn(inputs, 'selectRuntimePaneTitlesForWorktree'),
      vi.spyOn(inputs, 'selectLivePtyIdsForWorktree'),
      vi.spyOn(selectors, 'selectTerminalLayoutsForWorktree'),
      vi.spyOn(inputs, 'selectPaneForegroundAgentsForWorktree')
    ]
    useAppStore.setState({
      runtimePaneTitlesByTabId: titles.source(
        Object.fromEntries(Array.from({ length: n }, (_, i) => [`tab-${i}`, { 0: `Pane ${i}` }]))
      ),
      ptyIdsByTabId: ptys.source(
        Object.fromEntries(Array.from({ length: n }, (_, i) => [`tab-${i}`, [`pty-${i}`]]))
      ),
      terminalLayoutsByTabId: layouts.source(
        Object.fromEntries(
          Array.from({ length: n }, (_, i): [string, TerminalLayoutSnapshot] => [
            `tab-${i}`,
            { root: { type: 'leaf', leafId: LEAF }, activeLeafId: LEAF, expandedLeafId: null }
          ])
        )
      ),
      paneForegroundAgentByPaneKey: foreground.source(
        Object.fromEntries(
          Array.from({ length: n }, (_, i) => [
            status(i).paneKey,
            { agent: 'claude' as const, shellForeground: false }
          ])
        )
      )
    })
    const select = selectors.selectLiveAgentStatusEntriesForWorktree
    const input = vi
      .spyOn(selectors, 'selectLiveAgentStatusEntriesForWorktree')
      .mockImplementation((...args) => {
        const result = select(...args)
        entries += result.length
        let proxy = arrays.get(result)
        if (!proxy) {
          proxy = new Proxy(result, {
            get(target, key) {
              if (fresh && typeof key === 'string' && /^\d+$/.test(key)) {
                freshnessVisits++
              }
              // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: plain fixture data has no accessor overrides; methods retain the caller's proxy receiver and indexed reads remain counted.
              return target[key as keyof typeof target]
            }
          })
          arrays.set(result, proxy)
        }
        return proxy
      })
    const builds = vi.spyOn(rows, 'buildWorktreeAgentRows')
    const normalized = vi.spyOn(presentation, 'resolveRowProgramStatus')
    render(
      <>
        {Array.from({ length: n }, (_, id) => (
          <Probe key={id} id={id} sender={id % (n - 1)} />
        ))}
      </>
    )
    expect(builds).toHaveBeenCalledTimes(1)
    expect(builds.mock.calls[0][0].entries).toHaveLength(n)
    expect(normalized).toHaveBeenCalledTimes(n)
    expect(preProjectorStatusValueVisits).toBe(n * 2)
    expect(entries).toBe(n * input.mock.calls.length)
    expect(freshnessVisits).toBe(n)
    expect(projections).toHaveBeenCalledTimes(1)
    for (const spy of recordSelectors) {
      expect(spy).toHaveBeenCalledTimes(1)
    }
    for (const [name, metric] of recordWork) {
      expect(metric.source).toBe(name === 'ptys' ? n * 2 : n)
    }
    const counts = new Map(renders)
    const reset = () => {
      for (const spy of [input, builds, projections, normalized, ...recordSelectors]) {
        spy.mockClear()
      }
      entries = freshnessVisits = preProjectorStatusValueVisits = 0
      for (const metric of recordWork.values()) {
        metric.source = 0
      }
    }
    // Each record generation actually reconstructs the full workspace; the unchanged authority
    // shallow-compares the N built entries and carries the old identity (status-inputs contract).
    const state = useAppStore.getState()
    const nextRecords = {
      runtimePaneTitlesByTabId: titles.source({ ...state.runtimePaneTitlesByTabId }),
      ptyIdsByTabId: ptys.source({ ...state.ptyIdsByTabId }),
      terminalLayoutsByTabId: layouts.source({ ...state.terminalLayoutsByTabId }),
      paneForegroundAgentByPaneKey: foreground.source({ ...state.paneForegroundAgentByPaneKey })
    }
    for (const [update, reads, statusValueVisits] of [
      [nextRecords, n, n],
      [{ sidebarBody: 'agents' as const }, 0, 0],
      [{ settings: { ...settings } }, 0, n * 2]
    ] as const) {
      reset()
      act(() => useAppStore.setState(update))
      expect(projections).toHaveBeenCalledTimes(1)
      expect(builds).not.toHaveBeenCalled()
      expect(normalized).not.toHaveBeenCalled()
      expect(entries).toBe(n * input.mock.calls.length)
      expect(freshnessVisits).toBe(0)
      for (const spy of recordSelectors) {
        expect(spy).toHaveBeenCalledTimes(1)
      }
      for (const [name, metric] of recordWork) {
        expect(metric.source).toBe(name === 'ptys' ? reads * 2 : reads)
      }
      expect(preProjectorStatusValueVisits).toBe(statusValueVisits)
      expect(renders).toEqual(counts)
    }
    for (const facetOnly of [true, false]) {
      reset()
      const epoch = useAppStore.getState().agentStatusEpoch
      if (facetOnly) {
        act(() => {
          useAppStore.getState().setAgentProgramStatus(status(1).paneKey, {
            state: 'working',
            progress: 40,
            observedAt: 2_000_000
          })
        })
        expect(useAppStore.getState().agentStatusEpoch).toBe(epoch)
        expect(views.get(1)?.progress).toBe(40)
        expect(renders.get(1)).toBe(counts.get(1)! + 1)
        counts.set(1, renders.get(1)!)
      } else {
        write(n - 1, { state: 'blocked' })
      }
      expect(builds).toHaveBeenCalledTimes(1)
      expect(builds.mock.calls[0][0].entries).toHaveLength(n)
      expect(normalized).toHaveBeenCalledTimes(n)
      expect(preProjectorStatusValueVisits).toBe(n * 2)
      expect(entries).toBe(n * input.mock.calls.length)
      expect(freshnessVisits).toBe(facetOnly ? 0 : n)
      expect(projections).toHaveBeenCalledTimes(1)
      for (const spy of recordSelectors) {
        expect(spy).toHaveBeenCalledTimes(1)
      }
      for (const metric of recordWork.values()) {
        expect(metric.source).toBe(0)
      }
      expect(renders).toEqual(counts)
    }
    const live = Object.fromEntries(
      Array.from({ length: n }, (_, i) => {
        const entry = status(i)
        return [entry.paneKey, entry]
      })
    )
    const retained = Object.fromEntries(
      Array.from({ length: n }, (_, i) => {
        const entry = { ...status(i), paneKey: `retained-${i}:${LEAF}`, state: 'done' as const }
        return [
          entry.paneKey,
          {
            entry,
            tab: makeTab({ id: `retained-${i}`, worktreeId: 'workspace' }),
            worktreeId: 'workspace',
            agentType: 'claude' as const,
            startedAt: 1
          }
        ]
      })
    )
    const migration = Object.fromEntries(
      Array.from({ length: n }, (_, i) => [
        `migration-${i}`,
        {
          ptyId: `migration-${i}`,
          worktreeId: 'workspace',
          tabId: `migration-${i}`,
          leafId: LEAF,
          paneKey: `migration-${i}:${LEAF}`,
          reason: 'legacy-numeric-pane-key' as const,
          source: 'local' as const,
          updatedAt: 1
        }
      ])
    )
    const orchestration = Object.fromEntries(
      Array.from({ length: n }, (_, i) => [
        status(i).paneKey,
        { taskId: `task-${i}`, dispatchId: `dispatch-${i}`, orchestrationRunId: `run-${i}` }
      ])
    )
    for (const source of [live, retained, migration, orchestration]) {
      population.set(source, { calls: 0, entries: 0 })
    }
    const enumerated = (source: SenderPopulation, length: number) => {
      const metric = population.get(source)
      if (metric) {
        metric.calls++
        metric.entries += length
      }
    }
    const objectEntries = Object.entries
    vi.spyOn(Object, 'entries').mockImplementation((source: SenderPopulation) => {
      const result = objectEntries(source)
      enumerated(source, result.length)
      return result
    })
    reset()
    act(() =>
      useAppStore.setState({
        agentStatusByPaneKey: live,
        retainedAgentsByPaneKey: retained,
        migrationUnsupportedByPtyId: migration,
        runtimeAgentOrchestrationByPaneKey: orchestration,
        tabsByWorktree: {
          workspace: Array.from({ length: n }, (_, i) => [
            makeTab({ id: `tab-${i}`, worktreeId: 'workspace' }),
            makeTab({ id: `retained-${i}`, worktreeId: 'workspace' }),
            makeTab({ id: `migration-${i}`, worktreeId: 'workspace' })
          ]).flat()
        }
      })
    )
    expect(projections).toHaveBeenCalledTimes(1)
    expect(builds).toHaveBeenCalledTimes(1)
    const args = builds.mock.calls[0][0]
    expect(args.tabs).toHaveLength(n * 3)
    expect(args.entries).toHaveLength(n * 2)
    expect(args.retained).toHaveLength(n)
    expect(Object.keys(args.runtimeAgentOrchestrationByPaneKey!)).toHaveLength(n)
    expect(normalized).toHaveBeenCalledTimes(n * 3)
    for (const source of [live, retained]) {
      expect(population.get(source)).toEqual({ calls: 3, entries: n * 3 })
    }
    for (const source of [migration, orchestration]) {
      expect(population.get(source)).toEqual({ calls: 1, entries: n })
    }
    for (const metric of population.values()) {
      metric.calls = metric.entries = 0
    }
    reset()
    act(() => useAppStore.setState({ sidebarBody: 'workspaces' }))
    expect(projections).toHaveBeenCalledTimes(1)
    expect(builds).not.toHaveBeenCalled()
    expect(normalized).not.toHaveBeenCalled()
    for (const metric of population.values()) {
      expect(metric).toEqual({ calls: 0, entries: 0 })
    }
  }
)

it('uses the child row own glyph even when its parent program needs permission', () => {
  write(0, {
    programStatus: { state: 'blocked', progress: 60, observedAt: 2_000_000 },
    subagents: [{ id: 'child', state: 'working', startedAt: 2_000_000, description: 'Child' }]
  })
  const state = useAppStore.getState()
  const projected = cache.selectWorktreeAgentRowsCached({
    state,
    worktreeId: 'workspace',
    now: 2_000_000,
    generation: '',
    orchestration: selectors.selectRuntimeAgentOrchestrationForWorktree(state, 'workspace')
  })
  const child = projected.find((row) => row.childRow)!
  expect(child).toBeDefined()
  const locate = () => ({ host: 'local', worktreeId: 'workspace', paneKey: child.paneKey })
  let value: AgentMessageSenderView | undefined
  function Child() {
    value = useAgentMessageSenderSource(locate)
    return value.dot ? (
      <AgentStateDot state={value.dot} progress={value.progress} size="md" title={null} />
    ) : null
  }
  render(<Child />)
  expect(value?.dot).toBe('working')
  expect(value?.progress).toBeUndefined()
  expect(screen.queryByRole('progressbar')).toBeNull()
  expect(screen.getByLabelText('Working')).toBeDefined()
})

it('uses the navigation owner rule for the target-less ambiguous stamped twin, preserving explicit targets', () => {
  const workspace = `${TEST_REPO.id}::/w`
  const entry = status(0, workspace)
  useAppStore.setState({
    repos: [TEST_REPO],
    activeWorktreeId: 'different',
    activeWorkspaceExecutionHostId: 'local',
    detectedWorktreesByRepo: {},
    worktreesByRepo: {
      [TEST_REPO.id]: [
        makeWorktree({ id: workspace, repoId: TEST_REPO.id, hostId: 'local' }),
        makeWorktree({ id: workspace, repoId: TEST_REPO.id, hostId: 'runtime:e' })
      ]
    },
    tabsByWorktree: { [workspace]: [makeTab({ id: 'tab-0', worktreeId: workspace })] },
    agentStatusByPaneKey: { [entry.paneKey]: entry }
  })
  const state = useAppStore.getState()
  expect(owners.getKnownExecutionHostIdForWorktree(state, workspace)).toBe('local')
  expect(structuredOwner.resolveStructuredAgentSessionOwner(state, workspace)).toBeNull()
  expect(senderLocation.agentMessageSenderOwner(state, workspace)).toBeNull()
  const sender = {
    party: { address: 'term_0', terminalHandle: 'term_0', orcaSessionId: null },
    name: 'Snapshot'
  }
  const view = renderHook(() => useAgentMessageSenderView(sender, workspace))
  expect(view.result.current).toEqual({})
  view.unmount()
  // Explicit receiving host continues to resolve its sender; missing glyph never decides control eligibility.
  const explicit = renderHook(() => useAgentMessageSenderView(sender, workspace, { kind: 'local' }))
  expect(explicit.result.current.dot).toBe('working')
})
