import { bindPtyConnectionTestMocks } from './pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { flushAsyncTicks } from './pty-connection-test-async'
import { sendTerminalInputThroughPane } from './pty-connection-test-dom'
import {
  LEAF_1,
  createMockTransport,
  createPane,
  createManager,
  type MockTransport
} from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import {
  createInitialStoreState,
  buildActiveRuntimeEnvironmentState
} from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'

export function registerPtyConnectionTypedAgentIdentityTests(): void {
  let mockStoreState: StoreState
  let transportFactoryQueue: MockTransport[] = []
  let createdTransportOptions: Record<string, unknown>[] = []
  let storeSubscribers: ((state: StoreState) => void)[] = []

  function createDeps(overrides: Record<string, unknown> = {}) {
    return buildPaneConnectionDeps(() => mockStoreState, overrides)
  }

  // Why: activeRuntimeEnvironmentId exercises the remote-runtime path where the renderer still owns OSC 9999 status.
  function enableActiveRuntimeEnvironment(environmentId = 'env-1'): void {
    mockStoreState = buildActiveRuntimeEnvironmentState(mockStoreState, environmentId)
  }

  describe('connectPanePty', () => {
    beforeEach(async () => {
      vi.resetModules()
      vi.clearAllMocks()
      transportFactoryQueue = []
      createdTransportOptions = []
      storeSubscribers = []
      mockStoreState = createInitialStoreState(() => mockStoreState)
      bindPtyConnectionTestMocks({
        getState: () => mockStoreState,
        getTransportQueue: () => transportFactoryQueue,
        getTransportOptions: () => createdTransportOptions,
        getStoreSubscribers: () => storeSubscribers,
        setStoreSubscribers: (subscribers) => {
          storeSubscribers = subscribers
        }
      })
      await installTerminalTestGlobals()
    })

    afterEach(async () => {
      await restoreTerminalTestGlobals()
    })

    it('keeps the observed Pi identity when typed omp never produces real OMP evidence', async () => {
      const { connectPanePty } = await import('./pty-connection')
      enableActiveRuntimeEnvironment()
      const paneKey = makePaneKey('tab-1', LEAF_1)
      const pane = createPane(1)
      const transport = createMockTransport('remote:web-env-1@@pty-omp')
      transportFactoryQueue.push(transport)
      const manager = createManager(1, 1)
      const deps = createDeps()

      connectPanePty(pane as never, manager as never, deps as never)
      sendTerminalInputThroughPane(pane, 'omp\r')
      await flushAsyncTicks()
      const onTitleChange = createdTransportOptions[0]?.onTitleChange as
        | ((title: string, rawTitle: string) => void)
        | undefined
      const onAgentStatus = createdTransportOptions[0]?.onAgentStatus as
        | ((payload: { state: 'done'; prompt: string; agentType: 'pi' }) => void)
        | undefined
      if (!onTitleChange || !onAgentStatus) {
        throw new Error('missing remote PTY callbacks')
      }
      onTitleChange('Pi ready', 'Pi ready')
      onAgentStatus({
        state: 'done',
        prompt: '',
        agentType: 'pi'
      })

      expect(transport.sendInput).toHaveBeenCalledWith('omp\r', 'query-reply')
      expect(deps.setRuntimePaneTitle).toHaveBeenCalledWith('tab-1', 1, 'Pi ready')
      expect(deps.updateTabTitle).toHaveBeenCalledWith('tab-1', 'Pi ready')
      expect(mockStoreState.agentStatusByPaneKey[paneKey]).toMatchObject({
        state: 'done',
        agentType: 'pi'
      })
    })

    it('drives runtime title, tab title, and renderer policy from one title decision', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const pane = createPane(1)
      const transport = createMockTransport('pty-gemini')
      transportFactoryQueue.push(transport)
      const manager = createManager(1, 1)
      const deps = createDeps()

      connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks()
      const onTitleChange = createdTransportOptions[0]?.onTitleChange as
        | ((title: string, rawTitle: string) => void)
        | undefined
      if (!onTitleChange) {
        throw new Error('missing title callback')
      }
      onTitleChange('✦ Gemini CLI', '✦ Gemini CLI')

      // Display/runtime/tab title and the GPU gate all come from the same decision.
      expect(deps.setRuntimePaneTitle).toHaveBeenCalledWith('tab-1', 1, '✦ Gemini CLI')
      expect(deps.updateTabTitle).toHaveBeenCalledWith('tab-1', '✦ Gemini CLI')
      // Genuine Gemini under the default `auto` setting takes the DOM fallback.
      expect(manager.setPaneGpuRendering).toHaveBeenCalledWith(1, false)
    })

    it('keeps GPU enabled when a pane-scoped OMP owner emits a Gemini-looking title', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const paneKey = makePaneKey('tab-1', LEAF_1)
      mockStoreState = {
        ...mockStoreState,
        agentStatusByPaneKey: {
          [paneKey]: {
            paneKey,
            agentType: 'omp',
            state: 'working',
            prompt: '',
            updatedAt: Date.now(),
            stateStartedAt: Date.now(),
            stateHistory: []
          }
        }
      } as StoreState
      const pane = createPane(1)
      const transport = createMockTransport('pty-omp-gemini-cwd')
      transportFactoryQueue.push(transport)
      const manager = createManager(1, 1)
      const deps = createDeps()

      connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks()
      const onTitleChange = createdTransportOptions[0]?.onTitleChange as
        | ((title: string, rawTitle: string) => void)
        | undefined
      if (!onTitleChange) {
        throw new Error('missing title callback')
      }
      onTitleChange('✦ Gemini CLI', '✦ Gemini CLI')

      // Pane-scoped owner evidence outranks the raw title, so the fallback cannot fire.
      expect(manager.setPaneGpuRendering).toHaveBeenCalledWith(1, true)
      expect(manager.setPaneGpuRendering).not.toHaveBeenCalledWith(1, false)
    })

    it('does not let one split pane title change another pane GPU state', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const pane1 = createPane(1)
      const pane2 = createPane(2)
      const transport1 = createMockTransport('pty-split-1')
      const transport2 = createMockTransport('pty-split-2')
      transportFactoryQueue.push(transport1, transport2)
      const manager = createManager(2, 1)

      connectPanePty(pane1 as never, manager as never, createDeps() as never)
      connectPanePty(pane2 as never, manager as never, createDeps() as never)
      await flushAsyncTicks()
      const onTitleChange1 = createdTransportOptions[0]?.onTitleChange as
        | ((title: string, rawTitle: string) => void)
        | undefined
      if (!onTitleChange1) {
        throw new Error('missing title callback for split pane 1')
      }
      onTitleChange1('✦ Gemini CLI', '✦ Gemini CLI')

      const gpuCalls = manager.setPaneGpuRendering.mock.calls as [number, boolean][]
      expect(gpuCalls.some(([paneId]) => paneId === 1)).toBe(true)
      expect(gpuCalls.every(([paneId]) => paneId !== 2)).toBe(true)
    })

    it('DOM-gates a genuine Gemini split pane even when the tab launched a non-Gemini agent', async () => {
      const { connectPanePty } = await import('./pty-connection')
      // The shared tab.launchAgent must not veto the renderer for a sibling pane.
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: {
          'wt-1': [{ id: 'tab-1', ptyId: 'tab-pty', launchAgent: 'omp' }]
        }
      } as StoreState
      const pane1 = createPane(1)
      const pane2 = createPane(2)
      const transport1 = createMockTransport('pty-split-owner-1')
      const transport2 = createMockTransport('pty-split-owner-2')
      transportFactoryQueue.push(transport1, transport2)
      const manager = createManager(2, 2)

      connectPanePty(pane1 as never, manager as never, createDeps() as never)
      connectPanePty(pane2 as never, manager as never, createDeps() as never)
      await flushAsyncTicks()
      const onTitleChange2 = createdTransportOptions[1]?.onTitleChange as
        | ((title: string, rawTitle: string) => void)
        | undefined
      if (!onTitleChange2) {
        throw new Error('missing title callback for split pane 2')
      }
      onTitleChange2('✦ Gemini CLI', '✦ Gemini CLI')

      expect(manager.setPaneGpuRendering).toHaveBeenCalledWith(2, false)
    })

    it('DOM-gates a genuine Gemini title in a pane whose launch agent was non-Gemini', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const pane = createPane(1)
      const transport = createMockTransport('pty-reused-gemini')
      transportFactoryQueue.push(transport)
      const manager = createManager(1, 1)
      // Stale, never-cleared launch identity must not veto the renderer.
      const deps = createDeps({ startup: { command: 'claude', launchAgent: 'claude' } })

      connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks()
      const onTitleChange = createdTransportOptions[0]?.onTitleChange as
        | ((title: string, rawTitle: string) => void)
        | undefined
      if (!onTitleChange) {
        throw new Error('missing title callback')
      }
      onTitleChange('✦ Gemini CLI', '✦ Gemini CLI')

      expect(manager.setPaneGpuRendering).toHaveBeenCalledWith(1, false)
    })

    it('DOM-gates a genuine Gemini title when the only pane row is a done non-Gemini agent', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const paneKey = makePaneKey('tab-1', LEAF_1)
      mockStoreState = {
        ...mockStoreState,
        agentStatusByPaneKey: {
          [paneKey]: {
            paneKey,
            agentType: 'claude',
            state: 'done',
            prompt: '',
            updatedAt: Date.now(),
            stateStartedAt: Date.now(),
            stateHistory: []
          }
        }
      } as StoreState
      const pane = createPane(1)
      const transport = createMockTransport('pty-reused-done-row')
      transportFactoryQueue.push(transport)
      const manager = createManager(1, 1)
      const deps = createDeps()

      connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks()
      const onTitleChange = createdTransportOptions[0]?.onTitleChange as
        | ((title: string, rawTitle: string) => void)
        | undefined
      if (!onTitleChange) {
        throw new Error('missing title callback')
      }
      onTitleChange('✦ Gemini CLI', '✦ Gemini CLI')

      // A `done` row is a leftover from a prior agent, so it must not veto.
      expect(manager.setPaneGpuRendering).toHaveBeenCalledWith(1, false)
    })

    it('DOM-gates a genuine Gemini title when the only pane row is a stale non-Gemini agent', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const paneKey = makePaneKey('tab-1', LEAF_1)
      const staleAt = Date.now() - 60 * 60 * 1000
      mockStoreState = {
        ...mockStoreState,
        agentStatusByPaneKey: {
          [paneKey]: {
            paneKey,
            agentType: 'claude',
            state: 'working',
            prompt: '',
            updatedAt: staleAt,
            stateStartedAt: staleAt,
            stateHistory: []
          }
        }
      } as StoreState
      const pane = createPane(1)
      const transport = createMockTransport('pty-reused-stale-row')
      transportFactoryQueue.push(transport)
      const manager = createManager(1, 1)
      const deps = createDeps()

      connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks()
      const onTitleChange = createdTransportOptions[0]?.onTitleChange as
        | ((title: string, rawTitle: string) => void)
        | undefined
      if (!onTitleChange) {
        throw new Error('missing title callback')
      }
      onTitleChange('✦ Gemini CLI', '✦ Gemini CLI')

      // A stale working row (older than AGENT_STATUS_STALE_AFTER_MS) must not veto.
      expect(manager.setPaneGpuRendering).toHaveBeenCalledWith(1, false)
    })

    it.each([false, true])('uses process-read OMP with title first=%s without inventing status', async (titleFirst) => {
      const { connectPanePty } = await import('./pty-connection')
      enableActiveRuntimeEnvironment()
      const paneKey = makePaneKey('tab-1', LEAF_1)
      const pane = createPane(1)
      transportFactoryQueue.push(createMockTransport('remote:web-env-1@@observed-omp'))
      const manager = createManager(1, 1)
      const deps = createDeps()
      connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks()
      const callbacks = createdTransportOptions[0] as {
        onTitleChange: (title: string, raw: string) => void
        onAgentStatus: (payload: { state: 'working'; prompt: string; agentType: 'pi' }) => void
      }
      const title = () => callbacks.onTitleChange('Pi ready', 'Pi ready')
      const status = () => callbacks.onAgentStatus({ state: 'working', prompt: 'task', agentType: 'pi' })
      if (titleFirst) { title(); status() }
      const prior = mockStoreState.agentStatusByPaneKey[paneKey]
      const writes = mockStoreState.setAgentStatus.mock.calls.length
      mockStoreState.setPaneForegroundAgent(paneKey, {
        agent: 'omp', agentEvidence: 'process-read', shellForeground: false
      })
      for (const subscriber of storeSubscribers) subscriber(mockStoreState)
      if (!titleFirst) { title(); status() }
      expect(deps.setRuntimePaneTitle).toHaveBeenLastCalledWith('tab-1', 1, 'OMP ready')
      expect(deps.updateTabTitle).toHaveBeenLastCalledWith('tab-1', 'OMP ready')
      expect(mockStoreState.agentStatusByPaneKey[paneKey]).toMatchObject({ agentType: 'omp', state: 'working' })
      if (titleFirst) {
        expect(mockStoreState.setAgentStatus).toHaveBeenCalledTimes(writes)
        expect(mockStoreState.agentStatusByPaneKey[paneKey]).toEqual({ ...Object(prior), agentType: 'omp' })
      }
    })

    it('refreshes a misleading GPU title on late process evidence without replaying completion', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const paneKey = makePaneKey('tab-1', LEAF_1)
      const pane = createPane(1)
      transportFactoryQueue.push(createMockTransport('pty-observed-gpu'))
      const manager = createManager(1, 1)
      const deps = createDeps()
      connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks()
      const onTitle = createdTransportOptions[0].onTitleChange as (title: string, raw: string) => void
      onTitle('✦ Gemini CLI', '✦ Gemini CLI')
      expect(manager.setPaneGpuRendering).toHaveBeenLastCalledWith(1, false)
      const timerWrites = deps.setCacheTimerStartedAt.mock.calls.length
      mockStoreState.setPaneForegroundAgent(paneKey, {
        agent: 'omp', agentEvidence: 'process-read', shellForeground: false
      })
      for (const subscriber of storeSubscribers) subscriber(mockStoreState)
      expect(manager.setPaneGpuRendering).toHaveBeenLastCalledWith(1, true)
      expect(deps.setCacheTimerStartedAt).toHaveBeenCalledTimes(timerWrites)
      expect(mockStoreState.setAgentStatus).not.toHaveBeenCalled()
    })

    it('retains OMP hook display identity through inter-turn done without GPU or routing authority', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const { dispatchAgentHookTerminalLifecycle } = await import('./agent-hook-terminal-lifecycle')
      const paneKey = makePaneKey('tab-1', LEAF_1)
      const pane = createPane(1)
      transportFactoryQueue.push(createMockTransport('pty-hook-omp'))
      const manager = createManager(1, 1)
      const deps = createDeps()
      connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks()
      for (const state of ['working', 'done'] as const) {
        mockStoreState.setAgentStatus(paneKey, { state, prompt: 'task', agentType: 'omp' })
        dispatchAgentHookTerminalLifecycle(paneKey, { state, agentType: 'omp' })
        for (const subscriber of storeSubscribers) subscriber(mockStoreState)
      }
      const onTitle = createdTransportOptions[0].onTitleChange as (title: string, raw: string) => void
      onTitle('Pi ready', 'Pi ready')
      expect(deps.setRuntimePaneTitle).toHaveBeenLastCalledWith('tab-1', 1, 'OMP ready')
      onTitle('✦ Gemini CLI', '✦ Gemini CLI')
      expect(manager.setPaneGpuRendering).toHaveBeenLastCalledWith(1, false)
      expect(mockStoreState.paneForegroundAgentByPaneKey[paneKey]?.routingTrusted).not.toBe(true)
    })
  })
}
