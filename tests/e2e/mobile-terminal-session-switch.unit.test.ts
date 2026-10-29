import type { StoreApi } from 'zustand'
import type { AppState } from '../../src/renderer/src/store/types'
import { createTestStore } from '@/store/slices/store-test-helpers'
import { createTabsSliceMockApi } from '@/store/slices/tabs-slice-test-harness'
import { publishAgentLaunchTab as windowPublish } from '@/lib/agent-launch-tab-publication'
import { applyAgentLaunchPaneVerdict } from '@/lib/agent-launch-pane-verdict-application'
import { acceptAgentLaunchPaneAttempt } from '@/lib/agent-launch-pane-start'
import { agentSessionSwitchDeadline } from '../../src/shared/agent-session-switch-execution'
import { afterEach, expect, it, vi } from 'vitest'
import '../../src/main/runtime/orca-runtime-test-lifecycle.spec'
import {
  OrcaRuntimeService,
  electronMocks
} from '../../src/main/runtime/orca-runtime-test-mocks.spec'
import {
  TEST_WORKTREE_ID as wt,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from '../../src/main/runtime/orca-runtime-test-fixtures.spec'
import { withChatTabChanges } from '../../src/main/runtime/agent-session/agent-session-tab-layout'
import { committingSpawn } from '../../src/main/runtime/bind-first-pane.test-fixture'
import type { RuntimeNotifier } from '../../src/main/runtime/runtime-notifier-contract'
import '../../src/main/daemon/mock-descendant-sweep'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DaemonPtyAdapter } from '../../src/main/daemon/daemon-pty-adapter'
import { DaemonServer } from '../../src/main/daemon/daemon-server'
import { getDaemonSocketPath } from '../../src/main/daemon/daemon-spawner'
import { createMockSubprocess } from '../../src/main/daemon/daemon-pty-adapter-test-harness'
import type { DaemonClientConnections } from '../../src/main/daemon/daemon-client-connections'
import type { RuntimePtyController } from '../../src/main/runtime/runtime-pty-controller-contract'

const renderer = vi.hoisted(() => {
  const ref: { store: StoreApi<AppState> | null } = { store: null }
  return ref
})
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => renderer.store!.getState(),
    setState: (...args: Parameters<ReturnType<typeof createTestStore>['setState']>) =>
      renderer.store!.setState(...args)
  }
}))
vi.mock('@/hooks/ipc-events/terminal-command-state', () => ({
  focusTerminalInitiatedTab: () => {}
}))

vi.mock('../../src/shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: false }))

type Spawn = NonNullable<RuntimePtyController['spawn']>

async function setup(outcome: 'ready' | 'failed' = 'ready', create?: Spawn) {
  createTabsSliceMockApi()
  renderer.store = createTestStore()
  renderer.store.getState().setActiveWorktree(wt)
  renderer.store.getState().createUnifiedTab(wt, 'agent-session', {
    id: 'custom-source',
    entityId: 'source-chat',
    agentSessionAgent: 'codex'
  })
  const initial = makeWorkspaceSessionWithHeadlessTerminal()
  const session =
    withChatTabChanges('local', initial, wt, [
      { open: { sessionId: 'source-chat', agent: 'codex', tabId: 'custom-source' } }
    ]) ?? initial
  const fixture = makeRuntimeStoreWithWorkspaceSession(session)
  const service = new OrcaRuntimeService(fixture.runtimeStore)
  const events: string[] = []
  const spawn = vi.fn(async (options: Parameters<Spawn>[0]) => {
    events.push('spawn')
    if (outcome === 'failed') {
      throw new Error('spawn rejected')
    }
    if (create) {
      return create(options)
    }
    return { id: 'pty-switch', incarnationId: '45454545-4545-4545-8545-454545454545' }
  })
  service.setPtyController({
    spawn: committingSpawn(service, spawn),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    listProcesses: async () => []
  })
  electronMocks.BrowserWindow.fromId.mockReturnValue({
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, setBackgroundThrottling: vi.fn() }
  })
  service.attachWindow(1)
  service.syncWindowGraph(1, {
    tabs: [],
    leaves: [],
    conditionalSwitchProjection: 1,
    rendererGeneration: 'window-test'
  })
  const publish = vi.spyOn(service, 'publishAgentLaunchTab').mockImplementation(async (request) => {
    events.push('published')
    expect(request.placement?.afterTabId).toBe('custom-source')
    expect(request.viewer).toBe('focus-in-workspace')
    expect(fixture.getSession().terminalLayoutsByTabId[request.tabId]).toBeUndefined()
    return windowPublish({ ...request, requestId: 'window-publication' })
  })
  const report = vi.spyOn(service, 'reportAgentLaunchPaneVerdict')
  const reveal = vi.fn<NonNullable<RuntimeNotifier['revealTerminalSession']>>(
    (_workspace, opts) => ({
      tabId: opts.tabId!,
      identity: { worktreeId: wt, tabId: opts.tabId!, leafId: opts.leafId!, ptyId: opts.ptyId }
    })
  )
  const { createMobileCreateTestNotifier } =
    await import('../../src/main/runtime/orca-runtime-test-scenario-builders.spec')
  service.setNotifier({
    ...createMobileCreateTestNotifier(vi.fn()),
    revealTerminalSession: reveal,
    publishAgentLaunchTab: async (request) =>
      windowPublish({ ...request, requestId: 'window-verdict' }),
    agentLaunchPaneVerdict: applyAgentLaunchPaneVerdict
  })
  service.projectStructuredAgentSessionTab({
    workspaceId: wt,
    sessionId: 'source-chat',
    agent: 'codex',
    activate: true
  })
  return { service, fixture, events, spawn, publish, report, reveal }
}
const deadlines: ReturnType<typeof agentSessionSwitchDeadline>[] = []
afterEach(() => {
  for (const deadline of deadlines) {
    deadline.dispose()
  }
})
function execution() {
  const deadline = agentSessionSwitchDeadline()
  deadlines.push(deadline)
  return {
    ...deadline,
    invocationId: 'click-1',
    viewer: 'focus-in-workspace' as const
  }
}
const args = () => ({
  agent: 'codex' as const,
  invocationId: 'click-1',
  sessionId: 'source-chat',
  afterTabId: 'custom-source',
  commandOverride: 'my-codex',
  options: { model: 'gpt-5.4', effort: 'high' },
  execution: execution()
})

it('publishes before ordinary fresh startup, forwards caller choices and never seeds a fabricated Codex ID', async () => {
  const { service, events, spawn, publish } = await setup()
  const created = await service.createSessionSwitchTerminal(wt, args())
  expect(events.slice(0, 2)).toEqual(['published', 'spawn'])
  expect(publish).toHaveBeenCalledOnce()
  expect(spawn).toHaveBeenCalledWith(
    expect.objectContaining({ command: expect.stringContaining('my-codex'), launchAgent: 'codex' })
  )
  expect(spawn.mock.calls[0]?.[0]).not.toHaveProperty('resumeProviderSession')
  expect(created.tab.terminal).toBeDefined()
})

it('withdraws a definitely unused destination after failed spawn', async () => {
  const { service, report, publish } = await setup('failed')
  await expect(service.createSessionSwitchTerminal(wt, args())).rejects.toThrow()
  expect(report).toHaveBeenCalledWith(expect.objectContaining({ worktreeId: wt }), {
    kind: 'withdrawn'
  })
  const published = await publish.mock.results[0]!.value
  expect(renderer.store!.getState().terminalLayoutsByTabId[published.tabId]).toBeUndefined()
})

it('retains an unresolved receiver destination until real no-fork settlement permits unused cleanup', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mobile-switch-receiver-'))
  const socketPath = getDaemonSocketPath(directory)
  const tokenPath = join(directory, 'test.token')
  const entered = Promise.withResolvers<void>()
  const releasePreparation = Promise.withResolvers<void>()
  const nativeSpawn = vi.fn(() => createMockSubprocess())
  const preparation = vi.fn(async () => {
    entered.resolve()
    await releasePreparation.promise
    throw new Error('workspace preparation failed')
  })
  const server = new DaemonServer({
    socketPath,
    tokenPath,
    spawnSubprocess: nativeSpawn,
    preparePtySpawn: preparation
  })
  const adapter = new DaemonPtyAdapter({ socketPath, tokenPath })
  let operation: Promise<unknown> | undefined
  try {
    await server.start()
    const { service, report, publish, spawn } = await setup('ready', (options) =>
      adapter.spawn(options)
    )
    operation = service.createSessionSwitchTerminal(wt, args()).catch((error: unknown) => error)
    await entered.promise
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: access only this fixture's authenticated server sockets to inject transport loss.
    const connections = (server as unknown as { connections: DaemonClientConnections }).connections
    const peer = [...connections.values()].find((connection) => connection.controlSocket)
    if (!peer) {
      throw new Error('authenticated receiver connection missing')
    }
    peer.controlSocket.destroy()
    expect(await operation).toBeInstanceOf(Error)
    const published = await publish.mock.results[0]!.value
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ worktreeId: wt }), {
      kind: 'unconfirmed'
    })
    expect(renderer.store!.getState().terminalLayoutsByTabId[published.tabId]?.root).toBeDefined()
    expect(report.mock.calls.some(([, verdict]) => verdict.kind === 'withdrawn')).toBe(false)
    expect(nativeSpawn).not.toHaveBeenCalled()
    releasePreparation.resolve()
    await adapter.settleSwitchWorkForReplacement()
    await vi.waitFor(() => {
      expect(renderer.store!.getState().terminalLayoutsByTabId[published.tabId]).toBeUndefined()
      expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ worktreeId: wt }), {
        kind: 'withdrawn'
      })
    })
    expect(preparation).toHaveBeenCalledOnce()
    expect(spawn).toHaveBeenCalledOnce()
    expect(nativeSpawn).not.toHaveBeenCalled()
    expect(server.host.listSessions()).toEqual([])
  } finally {
    releasePreparation.resolve()
    await operation
    await adapter.settleSwitchWorkForReplacement()
    adapter.dispose()
    await server.shutdown()
    rmSync(directory, { recursive: true, force: true })
  }
})

it('expires after preparation/publication without dispatching spawn, keeping the source', async () => {
  const { service, spawn, publish, report } = await setup()
  let expired = false
  const original = publish.getMockImplementation()!
  publish.mockImplementation(async (request) => {
    const answer = await original(request)
    if (!answer) {
      throw new Error('missing window publication')
    }
    expired = true
    return answer
  })
  await expect(
    service.createSessionSwitchTerminal(wt, {
      ...args(),
      execution: {
        ...execution(),
        check: () => {
          if (expired) {
            throw new Error('expired')
          }
        }
      }
    })
  ).rejects.toThrow('expired')
  expect(spawn).not.toHaveBeenCalled()
  expect(report).toHaveBeenCalledWith(expect.anything(), { kind: 'withdrawn' })
})

it('uses the saved native ID with ordinary resume environment/runtime instead of forking', async () => {
  const { service, spawn } = await setup()
  const nativeId = '019aef12-1234-7000-8000-123456789abc'
  await service.createSessionSwitchTerminal(wt, {
    ...args(),
    source: {
      agent: 'codex',
      sourceAgent: 'codex',
      sessionId: nativeId,
      filePath: '/tmp/rollout.jsonl',
      cwd: '/repo',
      codexHome: null,
      executionHostPlatform: process.platform
    }
  })
  expect(spawn).toHaveBeenCalledWith(
    expect.objectContaining({
      command: expect.stringContaining(nativeId),
      resumeProviderSession: expect.objectContaining({ id: nativeId }),
      launchRuntime: expect.any(Object)
    })
  )
  expect(spawn.mock.calls[0]?.[0].command).not.toContain('fork')
})

it.each(['input', 'replacement', 'preparing', 'layout'] as const)(
  'retains a window-published failed destination after newer %s before persistence',
  async (use) => {
    const { service, publish, spawn } = await setup('failed')
    const original = publish.getMockImplementation()!
    publish.mockImplementation(async (request) => {
      const receipt = await original(request)
      if (!receipt) {
        throw new Error('missing window publication')
      }
      const key = `${request.tabId}:${request.leafId}`
      if (use === 'input') {
        renderer.store!.setState({ lastTerminalInputAtByPaneKey: { [key]: 1 } })
      }
      if (use === 'preparing' || use === 'replacement') {
        acceptAgentLaunchPaneAttempt(key, 'new-launch')
      }
      if (use === 'replacement') {
        windowPublish({ ...request, operationId: 'new-launch', requestId: 'replacement' })
      }
      if (use === 'layout') {
        renderer.store!.setState((state) => ({
          terminalLayoutsByTabId: {
            ...state.terminalLayoutsByTabId,
            [request.tabId]: {
              ...state.terminalLayoutsByTabId[request.tabId]!,
              root: { type: 'leaf', leafId: 'changed' }
            }
          }
        }))
      }
      return receipt
    })
    await expect(service.createSessionSwitchTerminal(wt, args())).rejects.toThrow()
    const published = await publish.mock.results[0]!.value
    expect(
      renderer.store!.getState().tabsByWorktree[wt]?.some((row) => row.id === published.tabId)
    ).toBe(true)
    expect(spawn).toHaveBeenCalledOnce()
  }
)
