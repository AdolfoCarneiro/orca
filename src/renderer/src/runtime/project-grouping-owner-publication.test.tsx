// @vitest-environment happy-dom
import '../../../main/runtime/rpc/unused-default-rpc-methods.test-fixture'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { useAppStore } from '../store'
import { useRuntimeGraphSync } from '../app-shell/use-runtime-graph-sync'
import { getDefaultSettings } from '../../../shared/constants'
import { OrcaRuntimeService } from '../../../main/runtime/orca-runtime'
import { partialRuntimeStore } from '../../../main/runtime/runtime-store-partial-fixture'
import { registerRuntimeHandlers } from '../../../main/ipc/runtime'
import { MOBILE_PROJECT_SECTIONS_METHODS } from '../../../main/runtime/rpc/methods/mobile-project-sections'
import type { RuntimeRendererSyncWindowGraph } from '../../../shared/runtime-types'

const ipc = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>() }))
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  BrowserWindow: {
    fromWebContents: () => ({ id: 17 }),
    fromId: () => ({ isDestroyed: () => false })
  },
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => unknown) =>
      ipc.handlers.set(name, handler),
    removeHandler: () => {},
    removeAllListeners: () => {},
    on: () => {}
  }
}))

it('joins successful real settings/catalog owners to graph scheduling, IPC authority, readable snapshot and distinct remote invalidation', async () => {
  vi.useFakeTimers()
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  useAppStore.setState(useAppStore.getInitialState(), true)
  const settings = getDefaultSettings('')
  const runtime = new OrcaRuntimeService(
    partialRuntimeStore({
      getRepos: () => [],
      getAllWorktreeMeta: () => ({}),
      getWorktreeMeta: () => undefined,
      getSettings: () => settings
    })
  )
  runtime.attachWindow(17)
  registerRuntimeHandlers(runtime)
  const frame = {}
  const event = { sender: { mainFrame: frame }, senderFrame: frame }
  const accepted: RuntimeRendererSyncWindowGraph[] = []
  const read = () => MOBILE_PROJECT_SECTIONS_METHODS[0].handler(undefined, { runtime })
  let events = 0
  const stopEvents = runtime.onClientEvent(
    (message) => {
      if (message.type === 'reposChanged') {
        events++
        expect(read()).toMatchObject({ catalog: accepted.at(-1)?.projectSectionCatalog })
      }
    },
    { consumesTerminalSideEffects: false }
  )
  const syncWindowGraph = vi.fn(async (graph: RuntimeRendererSyncWindowGraph) => {
    accepted.push(graph)
    return ipc.handlers.get('runtime:syncWindowGraph')!(event, graph)
  })
  const getSettings = vi
    .fn()
    .mockRejectedValueOnce(new Error('settings offline'))
    .mockResolvedValue(settings)
  const list = vi.fn().mockRejectedValueOnce(new Error('catalog offline')).mockResolvedValue([])
  Object.assign(window, {
    api: {
      settings: {
        get: getSettings,
        set: vi.fn(async (patch) => ({ ...useAppStore.getState().settings, ...patch }))
      },
      repos: { list },
      runtime: { syncWindowGraph },
      runtimeEnvironments: { list: async () => [] }
    }
  })
  // Session startup may finish degraded; catalog/settings readiness must come from their real successful owners.
  useAppStore.setState({ workspaceSessionReady: true })
  function Producer() {
    useRuntimeGraphSync()
    return null
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const settle = async () => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
  }
  try {
    act(() => root.render(<Producer />))
    await act(async () => {
      await useAppStore.getState().fetchSettings()
      await useAppStore.getState().fetchRepos({ runtimeEnvironmentId: null })
    })
    await settle()
    expect(read).toThrow('runtime_unavailable')
    expect(accepted.every((graph) => !graph.projectSectionCatalog)).toBe(true)
    expect(events).toBe(0)
    await act(async () => {
      await useAppStore.getState().fetchSettings()
      await useAppStore.getState().fetchRepos({ runtimeEnvironmentId: null })
    })
    await settle()
    expect(accepted.at(-1)?.projectSectionCatalog).toMatchObject({ repos: [], setups: [] })
    expect(events).toBe(1)
    await act(async () => {
      await useAppStore.getState().fetchRepos({ runtimeEnvironmentId: null })
    })
    await settle()
    expect(events).toBe(1)
    list.mockResolvedValue([
      {
        id: 'a',
        path: '/a',
        displayName: 'App',
        badgeColor: '',
        addedAt: 0,
        upstream: { owner: 'org', repo: 'app' }
      },
      {
        id: 'b',
        path: '/b',
        displayName: 'App',
        badgeColor: '',
        addedAt: 0,
        upstream: { owner: 'org', repo: 'app' }
      }
    ])
    await act(async () => {
      await useAppStore.getState().fetchRepos({ runtimeEnvironmentId: null })
    })
    await settle()
    expect(events).toBe(2)
    expect(accepted.at(-1)?.projectSectionCatalog?.setups.map((setup) => setup.groupKey)).toEqual([
      'project:github:org/app',
      'project:github:org/app'
    ])
    await act(async () => {
      await useAppStore.getState().updateSettingsOrThrow({ projectGroupingMode: 'folder' })
    })
    await settle()
    expect(events).toBe(3)
    expect(
      new Set(accepted.at(-1)?.projectSectionCatalog?.setups.map((setup) => setup.groupKey)).size
    ).toBe(2)
    const known = read()
    expect(() =>
      ipc.handlers.get('runtime:syncWindowGraph')!({ ...event, senderFrame: {} }, accepted.at(-1))
    ).toThrow('current main frame')
    expect(read()).toEqual(known)
    expect(events).toBe(3)
    runtime.markRendererReloading(17)
    expect(read()).toEqual(known)
    runtime.markGraphReloadFailed(17, 'renderer-process-gone')
    expect(read()).toEqual(known)
  } finally {
    act(() => root.unmount())
    stopEvents()
    container.remove()
    useAppStore.setState(useAppStore.getInitialState(), true)
    vi.useRealTimers()
  }
})
