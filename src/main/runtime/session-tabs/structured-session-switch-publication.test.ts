import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  setupMainOwnedWorkspace,
  WORKTREE_ID,
  TAB_ID,
  LEAF_A,
  PTY_A
} from '../main-owned-workspace-runtime-fixture'
import { chatTabCommandsSettled } from '../session-layout-apply.test-fixture'
import { applyWorkspaceLayoutRecordChange } from '../../../shared/workspace-layout/workspace-layout-records'
import type { PublishedWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-published'
import { workspaceLayoutFromPublished } from '../../../shared/workspace-layout/workspace-layout-from-published'

const owner = vi.hoisted(() => ({ main: true }))
vi.mock('../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return owner.main
  }
}))
beforeEach(() => {
  owner.main = true
})
afterEach(() => vi.restoreAllMocks())

it('selects a newly published or already listed chat through the real main layout and headless view', async () => {
  const { runtime, session } = setupMainOwnedWorkspace()
  const frames: PublishedWorkspaceLayout[] = []
  const layouts = new Map<string, PublishedWorkspaceLayout>()
  const subscription = runtime.subscribeWorkspaceLayouts((event) => {
    if (event.type !== 'records') {
      return
    }
    for (const change of event.workspaces) {
      const next = applyWorkspaceLayoutRecordChange(layouts.get(change.key), change)
      if (next) {
        layouts.set(change.key, next)
        frames.push(next)
      } else {
        layouts.delete(change.key)
      }
    }
  })
  for (const entry of subscription.snapshot) {
    layouts.set(entry.key, entry.layout)
  }
  const input = {
    workspaceId: WORKTREE_ID,
    sessionId: 'destination',
    agent: 'codex' as const,
    activate: true,
    check: () => {},
    placement: { afterTabId: TAB_ID },
    openPlacement: {
      invocationId: 'chat-frame-open',
      generation: 'chat-frame-generation',
      placement: { afterTabId: TAB_ID },
      activate: true,
      viewerSelection: 'original-viewer'
    }
  }
  for (let repeat = 0; repeat < 2; repeat++) {
    await runtime.publishStructuredAgentSessionTab(input)
    await chatTabCommandsSettled()
    const snapshot = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
    expect(snapshot.activeTabId).toBe('agent-session:destination')
    const group = session().tabGroups?.[WORKTREE_ID]?.find((row) =>
      row.tabOrder.includes('agent-session:destination')
    )
    expect(group?.activeTabId).toBe('agent-session:destination')
    expect(group?.tabOrder).toEqual([TAB_ID, 'agent-session:destination'])
  }
  const first = frames.find((layout) => layout.tabs.some((tab) => tab.entityId === 'destination'))
  expect(first?.tabs.find((tab) => tab.entityId === 'destination')).toMatchObject({
    openPlacement: input.openPlacement
  })
  if (!first) {
    throw new Error('missing actual destination frame')
  }
  expect(JSON.stringify(workspaceLayoutFromPublished(first))).not.toContain('openPlacement')
  expect(JSON.stringify(session())).not.toContain('openPlacement')
  const late = runtime.subscribeWorkspaceLayouts(() => {})
  expect(
    late.snapshot
      .flatMap((entry) => entry.layout.tabs)
      .find((tab) => tab.entityId === 'destination')
  ).toMatchObject({ openPlacement: input.openPlacement })
  late.unsubscribe()
  subscription.unsubscribe()
})

it('publishes readable history while a queued main write preserves newer navigation', async () => {
  const { runtime } = setupMainOwnedWorkspace()
  await runtime.publishStructuredAgentSessionTab({
    workspaceId: WORKTREE_ID,
    sessionId: 'current-chat',
    agent: 'codex',
    activate: true,
    check: () => {}
  })
  const selectionCurrent = runtime.captureSessionSwitchSelection(WORKTREE_ID)
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const original = runtime.applyLayoutCommand.bind(runtime)
  vi.spyOn(runtime, 'applyLayoutCommand').mockImplementation(async (...args) => {
    entered.resolve()
    await release.promise
    return original(...args)
  })
  const publishing = runtime.publishStructuredAgentSessionTab({
    workspaceId: WORKTREE_ID,
    sessionId: 'destination',
    agent: 'codex',
    activate: true,
    check: () => {},
    selectionCurrent,
    openPlacement: {
      invocationId: 'held-publication',
      generation: 'held-generation',
      placement: { afterTabId: TAB_ID, index: 0 },
      activate: true,
      viewerSelection: 'original-viewer'
    }
  })
  await entered.promise
  expect(
    runtime.mobileSessionTabsByWorktree
      .get(WORKTREE_ID)
      ?.tabs.find((tab) => tab.type === 'agent-session' && tab.sessionId === 'destination')
  ).toMatchObject({
    openPlacement: { invocationId: 'held-publication', viewerSelection: 'original-viewer' }
  })
  runtime.projectStructuredAgentSessionTab({
    workspaceId: WORKTREE_ID,
    sessionId: 'newer-chat',
    agent: 'codex',
    activate: true
  })
  release.resolve()
  await publishing
  const snapshot = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
  expect(
    snapshot.tabs.some((tab) => tab.type === 'agent-session' && tab.sessionId === 'destination')
  ).toBe(true)
  expect(snapshot.activeTabId).toBe('agent-session:newer-chat')
})

it('keeps the captured source slot when natural-exit retirement reaches layout before publication', async () => {
  const { runtime, session } = setupMainOwnedWorkspace()
  const incarnationId = '11111111-1111-4111-8111-111111111111'
  runtime.registerPty(PTY_A, WORKTREE_ID, null, { tabId: TAB_ID, leafId: LEAF_A, incarnationId })
  expect(
    await runtime.applyLayoutCommand({
      type: 'openAgentSessionTab',
      workspace: WORKTREE_ID,
      sessionId: 'before-tab',
      agent: 'codex',
      tabId: 'agent-session:before-tab',
      index: 0
    })
  ).toMatchObject({ ok: true })
  await runtime.publishStructuredAgentSessionTab({
    workspaceId: WORKTREE_ID,
    sessionId: 'later-tab',
    agent: 'codex',
    activate: false,
    check: () => {}
  })
  const source = runtime.resolveTerminalPane(`${TAB_ID}:${LEAF_A}`, WORKTREE_ID)
  if (!source.presentation) {
    throw new Error('missing source')
  }
  const close = runtime.captureTerminalSwitchClose(
    source.handle,
    incarnationId,
    source.presentation
  )
  await runtime.onPtyExit(PTY_A, 0, incarnationId, { hostExitConfirmed: true })
  expect(
    await runtime.applyLayoutCommand({
      type: 'closeTabs',
      workspace: WORKTREE_ID,
      tabIds: [TAB_ID],
      force: true
    })
  ).toMatchObject({ ok: true })
  await close.stop()
  await runtime.publishStructuredAgentSessionTab({
    workspaceId: WORKTREE_ID,
    sessionId: 'destination',
    agent: 'codex',
    activate: true,
    check: () => {},
    placement: close.placement(),
    openPlacement: {
      invocationId: 'natural-exit',
      generation: 'natural-generation',
      placement: close.placement()!,
      activate: true,
      source: close.source
    }
  })
  const group = session().tabGroups?.[WORKTREE_ID]?.find((row) =>
    row.tabOrder.includes('agent-session:destination')
  )
  expect(group?.tabOrder).toEqual([
    'agent-session:before-tab',
    'agent-session:destination',
    'agent-session:later-tab'
  ])
  expect(group?.activeTabId).toBe('agent-session:destination')
  expect(
    await runtime.applyLayoutCommand({
      type: 'createTerminalTab',
      workspace: WORKTREE_ID,
      tabId: TAB_ID,
      leafId: LEAF_A
    })
  ).toMatchObject({ ok: true })
  expect(close.placement()).toBeUndefined()
})

it.each(['none', 'publication', 'spawn'] as const)(
  'keeps original selection through ordinary terminal publication and owned snapshot: navigation during %s',
  async (navigation) => {
    const { runtime, session, handleOf, bindPty } = setupMainOwnedWorkspace()
    Object.assign(runtime, {
      resolveTerminalWorkspaceLaunchScope: async () => ({
        id: WORKTREE_ID,
        path: '/workspace',
        connectionId: null,
        repo: null,
        folderWorkspace: null
      })
    })
    const selectionCurrent = runtime.captureSessionSwitchSelection(WORKTREE_ID)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const apply = runtime.applyLayoutCommand.bind(runtime)
    if (navigation === 'publication') {
      vi.spyOn(runtime, 'applyLayoutCommand').mockImplementation(async (...args) => {
        if (args[0].type === 'createTerminalTab') {
          entered.resolve()
          await release.promise
        }
        return apply(...args)
      })
    }
    vi.spyOn(runtime, 'createTerminal').mockImplementation(async (_selector, opts = {}) => {
      if (!opts.tabId || !opts.leafId) {
        throw new Error('missing ordinary published identity')
      }
      opts.beforePtySpawn?.()
      opts.onPtySpawnDispatched?.({
        tabId: opts.tabId,
        leafId: opts.leafId,
        launchAgent: 'codex',
        ...(opts.launchConfig ? { launchConfig: opts.launchConfig } : {})
      })
      const published = runtime.mobileSessionTabsByWorktree
        .get(WORKTREE_ID)
        ?.tabs.find(
          (tab) =>
            tab.type === 'terminal' && tab.parentTabId === opts.tabId && tab.leafId === opts.leafId
        )
      expect(published).toMatchObject({
        openPlacement: { generation: 'terminal-generation', viewerSelection: 'original-viewer' }
      })
      if (navigation === 'spawn') {
        entered.resolve()
        await release.promise
      }
      bindPty({
        worktreeId: WORKTREE_ID,
        tabId: opts.tabId,
        leafId: opts.leafId,
        ptyId: 'destination-pty'
      })
      runtime.registerPty('destination-pty', WORKTREE_ID, null, {
        tabId: opts.tabId,
        leafId: opts.leafId,
        terminalHandle: opts.preAllocatedHandle
      })
      return {
        handle: handleOf('destination-pty'),
        ptyId: 'destination-pty',
        tabId: opts.tabId,
        paneKey: `${opts.tabId}:${opts.leafId}`,
        worktreeId: WORKTREE_ID,
        title: null,
        surface: 'background'
      }
    })
    const operation = runtime.createMobileSessionTerminal(`id:${WORKTREE_ID}`, {
      command: 'cx',
      launchAgent: 'codex',
      clientMutationId: `ordinary-${navigation}`,
      switchExecution: {
        invocationId: `ordinary-${navigation}`,
        openPlacement: {
          invocationId: `ordinary-${navigation}`,
          generation: 'terminal-generation',
          placement: { afterTabId: TAB_ID, index: 0 },
          activate: true,
          viewerSelection: 'original-viewer'
        },
        check: () => {},
        signal: new AbortController().signal,
        remaining: () => 60_000,
        viewer: 'focus-in-workspace',
        viewerSelection: 'original-viewer',
        selectionCurrent
      }
    })
    const settled = operation.then(
      () => {},
      () => {}
    )
    try {
      if (navigation !== 'none') {
        await Promise.race([
          entered.promise,
          operation.then(() => {
            throw new Error('ordinary create settled before the held stage')
          })
        ])
        runtime.projectStructuredAgentSessionTab({
          workspaceId: WORKTREE_ID,
          sessionId: 'later-navigation',
          agent: 'codex',
          activate: true
        })
      }
    } finally {
      release.resolve()
      await settled
    }
    const result = await operation
    const snapshot = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
    expect(snapshot.activeTabId).toBe(
      navigation === 'none' ? result.tab.id : 'agent-session:later-navigation'
    )
    expect(snapshot.tabs.find((tab) => tab.id === result.tab.id)).toMatchObject({
      openPlacement: { generation: 'terminal-generation', activate: navigation === 'none' }
    })
    expect(
      session().terminalLayoutsByTabId[result.tab.parentTabId!]?.ptyIdsByLeafId?.[
        result.tab.leafId!
      ]
    ).toBe('destination-pty')
  }
)

it.each(['window', 'main', 'headless'] as const)(
  'carries addressed membership through %s publication and ordinary row rebuilds',
  async (mode) => {
    owner.main = mode === 'main'
    const { runtime, session } = setupMainOwnedWorkspace()
    await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
    if (mode !== 'headless') {
      Object.assign(runtime, { getAvailableAuthoritativeWindow: () => ({}) })
    }
    for (const agent of ['claude', 'codex'] as const) {
      const input = {
        workspaceId: WORKTREE_ID,
        sessionId: `placed-${agent}`,
        agent,
        activate: true,
        check: () => {},
        placement: { afterTabId: TAB_ID, index: 0 },
        openPlacement: {
          invocationId: `switch-${agent}`,
          generation: `generation-${agent}`,
          placement: { afterTabId: TAB_ID, index: 0 },
          activate: true,
          viewerSelection: 'original-history-viewer'
        }
      }
      await runtime.publishStructuredAgentSessionTab(input)
      const id = `agent-session:placed-${agent}`
      const snapshot = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
      expect(snapshot.tabs.find((tab) => tab.id === id)).toMatchObject({
        openPlacement: input.openPlacement
      })
      expect(
        snapshot.tabGroups?.find((group) => group.tabOrder.includes(id))?.tabOrder.slice(0, 2)
      ).toEqual([TAB_ID, id])
      // The ordinary graph can omit optional metadata; the same destination retains its intent.
      runtime.storeMobileSessionSnapshot(WORKTREE_ID, {
        ...snapshot,
        tabs: snapshot.tabs.map((tab) => {
          if (tab.type !== 'agent-session') {
            return tab
          }
          const { openPlacement: _placement, ...row } = tab
          return row
        })
      })
      expect(
        (await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)).tabs.find((tab) => tab.id === id)
      ).toMatchObject({ openPlacement: input.openPlacement })
      if (mode === 'window') {
        expect(
          session().unifiedTabs?.[WORKTREE_ID]?.some((tab) => tab.entityId === input.sessionId)
        ).not.toBe(true)
      }
    }
  }
)

it('settles a random retry placeholder around the original live switch destination without another dispatch', async () => {
  const { fixture, admitRuntimeSpawnPane } =
    await import('../../persistence/loading-store/profile-state-delayed-authority-fixture')
  const { OrcaRuntimeService } = await import('../orca-runtime')
  const { store } = await fixture()
  const worktreeId = 'repo-local::/fixture/local'
  const runtime = new OrcaRuntimeService(store)
  runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
  await admitRuntimeSpawnPane(store, { worktreeId, tabId: TAB_ID, leafId: LEAF_A })
  await store.persistPtyBinding({ worktreeId, tabId: TAB_ID, leafId: LEAF_A, ptyId: PTY_A })
  runtime.registerPty(PTY_A, worktreeId, null, { tabId: TAB_ID, leafId: LEAF_A })
  const session = () => store.getWorkspaceSession()
  Object.assign(runtime, {
    resolveTerminalWorkspaceLaunchScope: async () => ({
      id: worktreeId,
      path: '/fixture/local',
      connectionId: null,
      repo: null,
      folderWorkspace: null
    })
  })
  const inventory: {
    id: string
    worktreeId: string
    terminalHandle: string
    cwd: string
    title: string
  }[] = []
  let original: { tabId: string; leafId: string } | undefined
  const spawn = vi.fn(
    async (args: { tabId?: string; leafId?: string; preAllocatedHandle?: string }) => {
      if (!args.tabId || !args.leafId || !args.preAllocatedHandle) {
        throw new Error('missing actual dispatch identity')
      }
      original = { tabId: args.tabId, leafId: args.leafId }
      await store.persistPtyBinding({ worktreeId, ...original, ptyId: 'original-switch-live' })
      // The lower spawn publication arrives; only its observer reply is lost.
      runtime.registerPty('original-switch-live', worktreeId, null, {
        ...original,
        terminalHandle: args.preAllocatedHandle
      })
      inventory.push({
        id: 'original-switch-live',
        worktreeId,
        terminalHandle: args.preAllocatedHandle,
        cwd: '/fixture/local',
        title: 'Codex'
      })
      throw new Error('lost-successful-reply')
    }
  )
  const kill = vi.fn()
  runtime.setPtyController({
    spawn,
    kill,
    write: () => true,
    getForegroundProcess: async () => null,
    listProcesses: async () => inventory
  })
  const publish = vi.spyOn(runtime, 'publishAgentLaunchTabInMainLayout')
  const verdict = vi.spyOn(runtime, 'reportAgentLaunchPaneVerdict')
  const request = {
    command: 'cx',
    launchAgent: 'codex' as const,
    clientMutationId: 'same-switch-operation',
    switchExecution: {
      invocationId: 'same-switch-invocation',
      check: () => {},
      signal: new AbortController().signal,
      remaining: () => 60_000,
      viewer: 'none' as const,
      selectionCurrent: () => true
    }
  }
  await expect(runtime.createMobileSessionTerminal(`id:${worktreeId}`, request)).rejects.toThrow(
    'lost-successful-reply'
  )
  if (!original) {
    throw new Error('missing accepted original dispatch')
  }
  expect(session().terminalLayoutsByTabId[original.tabId]?.ptyIdsByLeafId?.[original.leafId]).toBe(
    'original-switch-live'
  )
  const result = await runtime.createMobileSessionTerminal(`id:${worktreeId}`, request)
  expect(result.tab).toMatchObject({
    parentTabId: original?.tabId,
    leafId: original?.leafId,
    ptyId: 'original-switch-live',
    status: 'ready'
  })
  expect(publish).toHaveBeenCalledTimes(2)
  const retryPane = publish.mock.calls[1][0]
  expect(retryPane.tabId).not.toBe(original?.tabId)
  await chatTabCommandsSettled()
  expect(session().tabsByWorktree[worktreeId].some((tab) => tab.id === retryPane.tabId)).toBe(false)
  expect(session().terminalLayoutsByTabId[original.tabId]?.ptyIdsByLeafId?.[original.leafId]).toBe(
    'original-switch-live'
  )
  expect(session().terminalLayoutsByTabId[TAB_ID]?.ptyIdsByLeafId?.[LEAF_A]).toBe(PTY_A)
  expect(
    verdict.mock.calls.some(
      ([pane, outcome]) => pane.tabId === retryPane.tabId && outcome.kind === 'proceed'
    )
  ).toBe(false)
  expect(verdict).toHaveBeenCalledWith(expect.objectContaining({ tabId: retryPane.tabId }), {
    kind: 'withdrawn'
  })
  expect(runtime.resolveTerminalPane(`${result.tab.parentTabId}:${result.tab.leafId}`).ptyId).toBe(
    'original-switch-live'
  )
  expect(spawn).toHaveBeenCalledOnce()
  expect(kill).not.toHaveBeenCalled()
})
