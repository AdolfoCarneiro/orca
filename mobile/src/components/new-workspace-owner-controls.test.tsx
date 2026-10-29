import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer, type ReactTestInstance } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'

const fixture = vi.hoisted(
  (): {
    client: RpcClient | null
    back: ReturnType<typeof vi.fn>
    replace: ReturnType<typeof vi.fn>
  } => ({ client: null, back: vi.fn(), replace: vi.fn() })
)
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} }
}))
vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'when-unlocked',
  getItemAsync: async () => null,
  setItemAsync: async () => {},
  deleteItemAsync: async () => {}
}))
vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
  FlatList: ({
    data,
    renderItem
  }: {
    data: unknown[]
    renderItem: (input: { item: unknown; index: number }) => ReactNode
  }) =>
    data.map((item, index) => createElement('View', { key: index }, renderItem({ item, index }))),
  Image: 'Image',
  Keyboard: { dismiss: () => {} },
  Linking: { openURL: async () => {} },
  Modal: 'Modal',
  ScrollView: 'ScrollView',
  Platform: { OS: 'ios', select: (options: { ios?: unknown }) => options.ios },
  Pressable: 'Pressable',
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
  Switch: 'Switch',
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View'
}))
vi.mock(
  'lucide-react-native',
  () =>
    new Proxy(
      {},
      { get: (_target, name) => (typeof name === 'string' ? name : undefined), has: () => true }
    )
)
vi.mock('./BottomDrawer', () => ({
  BottomDrawer: ({ visible, children }: { visible: boolean; children: ReactNode }) =>
    visible ? children : null
}))
vi.mock('./bottom-drawer-modal-host', () => ({
  BottomDrawerModalHost: ({ children }: { children: ReactNode }) => children
}))
vi.mock('./MobileAgentIcon', () => ({ MobileAgentIcon: 'MobileAgentIcon' }))
vi.mock('./TaskProviderLogo', () => ({ TaskProviderLogo: 'TaskProviderLogo' }))
vi.mock('expo-router', () => ({ useLocalSearchParams: () => ({ hostId: 'owner-controls' }) }))
vi.mock('../transport/host-client-hooks', () => ({
  useHostClient: () => ({ client: fixture.client, state: 'connected' })
}))
vi.mock('./host-protocol-gates-context', () => ({
  useHostProtocolGates: () => ({ hostCapabilities: [MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY] })
}))
vi.mock('../navigation/route-handoff', () => ({ useRouteHandoff: () => fixture }))
vi.mock('../platform/external-link', () => ({ openExternalLink: vi.fn() }))
vi.mock('../host-screen/workspace-options-sheet', () => ({ WorkspaceOptionsSheet: () => null }))
vi.mock('../host-screen/workspace-details-sheet', () => ({ WorkspaceDetailsSheet: () => null }))
vi.mock('./ConfirmModal', () => ({ ConfirmModal: () => null }))
vi.mock('./ActionSheetModal', () => ({ ActionSheetContent: () => null }))

import {
  MOBILE_PROJECT_SECTIONS_METHOD,
  buildMobileProjectSectionCatalog
} from '../../../src/shared/mobile-project-sections-contract'
import { projectHostSetupProjectionFromRepos } from '../../../src/shared/project-host-setup-projection'
import { MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY } from '../../../src/shared/mobile-desktop-relay-contract'
import { MOBILE_RELAY_HOSTS_LIST_METHOD } from '../../../src/shared/mobile-relay-hosts-contract'
import { stubRpcClient } from '../transport/rpc-client-test-stub'
import { NewWorkspacePageScreen } from '../new-workspace/NewWorkspacePageScreen'
import { HostScreenOverlays } from '../host-screen/host-screen-overlays'
import type { HostScreenController } from '../host-screen/use-host-screen-controller'
import { BOTTOM_DRAWER_HIDE_DURATION_MS } from './bottom-drawer-constants'

let renderer: ReactTestRenderer | undefined
const reply = (result: unknown): RpcResponse => ({ id: 'reply', ok: true, result })
const executionOptions = z.object({ envelope: z.object({ executionHost: z.string() }) })
const textOf = (node: ReactTestInstance) =>
  node
    .findAll((child) => String(child.type) === 'Text')
    .map((child) => child.props.children)
    .filter((child) => typeof child === 'string')
    .join(' ')
const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 20; i++) {
      await Promise.resolve()
    }
  })
}
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = undefined
  fixture.client = null
  vi.useRealTimers()
  vi.clearAllMocks()
})

it.each(['overlay', 'standalone'] as const)(
  'enables actual %s Project/Run/Create after failed then delayed owner read and installed same-client wake',
  async (entrance) => {
    vi.useFakeTimers()
    const local = {
      id: 'same',
      path: '/local/app',
      displayName: 'App',
      badgeColor: '',
      addedAt: 0,
      kind: 'git' as const,
      upstream: { owner: 'org', repo: 'app' }
    }
    const server = { ...local, path: '/server/app', executionHostId: 'runtime:server' as const }
    const projection = projectHostSetupProjectionFromRepos([local, server])
    const catalog = buildMobileProjectSectionCatalog(
      [local, server],
      projection,
      'manual',
      undefined,
      { projectGroupingMode: 'repository' }
    )
    const events = new Set<(event: unknown) => void>()
    let reads = 0
    let answer!: (value: RpcResponse) => void
    const delayed = new Promise<RpcResponse>((resolve) => {
      answer = resolve
    })
    const request = vi.fn<RpcClient['sendRequest']>(async (method, _params, options) => {
      const onServer =
        executionOptions.safeParse(options).data?.envelope.executionHost === 'runtime:server'
      if (method === MOBILE_PROJECT_SECTIONS_METHOD) {
        if (++reads === 1) {
          return {
            id: 'unknown',
            ok: false,
            error: { code: 'runtime_unavailable', message: 'Inputs not hydrated' }
          }
        }
        return delayed
      }
      if (method === MOBILE_RELAY_HOSTS_LIST_METHOD) {
        return reply({
          hosts: [
            { hostId: 'runtime:server', label: 'Server', health: 'available', relay: 'ready' }
          ]
        })
      }
      if (method === 'repo.list') {
        return reply({ repos: [onServer ? server : local] })
      }
      if (method === 'status.get') {
        return reply({ hostPlatform: onServer ? 'linux' : 'darwin', capabilities: [] })
      }
      if (method === 'settings.get') {
        return reply({ settings: { defaultTuiAgent: null, disabledTuiAgents: [] } })
      }
      if (method === 'worktree.create') {
        return reply({ worktree: { id: 'created', displayName: 'Proof', path: '/server/proof' } })
      }
      return reply({})
    })
    const client = stubRpcClient({
      sendRequest: request,
      subscribe: (_method, _params, onEvent) => {
        events.add(onEvent)
        return () => {
          events.delete(onEvent)
        }
      }
    })
    fixture.client = client
    const close = vi.fn()
    const navigate = vi.fn()
    const fetch = vi.fn(async () => {})
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: all fields read by HostScreenOverlays are supplied; unrelated sheets are outside the chain under proof.
    const controller = {
      client,
      connState: 'connected',
      hostCapabilities: [MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY],
      hostId: 'owner-controls',
      existingWorktreePaths: [],
      actions: { closeNewWorktreeModal: close, navigateFromHostList: navigate },
      catalog: { fetchWorktrees: fetch },
      state: {
        actionTarget: null,
        confirmDelete: null,
        confirmRemoveHost: false,
        hostName: 'Owner',
        showNewWorktree: true,
        hostLabelById: new Map(),
        worktrees: []
      }
    } as unknown as HostScreenController
    await act(async () => {
      renderer = create(
        entrance === 'overlay'
          ? createElement(HostScreenOverlays, { controller })
          : createElement(NewWorkspacePageScreen)
      )
    })
    await flush()
    const pressable = (label: string) =>
      renderer!.root
        .findAll((node) => String(node.type) === 'Pressable')
        .find((node) => textOf(node) === label)!
    expect(pressable('Select a project').props.disabled).toBe(true)
    expect(pressable('Select a run target').props.disabled).toBe(true)
    expect(pressable('Create worktree').props.disabled).toBe(true)
    expect(reads).toBe(1)
    await act(async () => {
      for (const event of events) {
        event({ type: 'reposChanged' })
      }
    })
    await flush()
    expect(reads).toBe(2)
    expect(pressable('Create worktree').props.disabled).toBe(true)
    await act(async () => answer(reply({ catalog })))
    await flush()
    const projectControl = renderer!.root
      .findAll((node) => String(node.type) === 'Pressable')
      .find((node) => textOf(node).startsWith('App'))!
    expect(projectControl.props.disabled).toBe(false)
    await act(async () => projectControl.props.onPress())
    await act(async () => vi.advanceTimersByTimeAsync(BOTTOM_DRAWER_HIDE_DURATION_MS + 1))
    const projectRow = renderer!.root
      .findAll((node) => String(node.type) === 'Pressable')
      .find((node) => textOf(node).startsWith('App'))!
    await act(async () => projectRow.props.onPress())
    await act(async () => vi.advanceTimersByTimeAsync(BOTTOM_DRAWER_HIDE_DURATION_MS + 1))
    await flush()
    // The field containing the selected checkout path is the real Run-on control.
    const run = renderer!.root
      .findAll((node) => String(node.type) === 'Pressable')
      .find((node) => textOf(node).includes('/local/app'))!
    await act(async () => run.props.onPress())
    await act(async () => vi.advanceTimersByTimeAsync(BOTTOM_DRAWER_HIDE_DURATION_MS + 1))
    const serverRow = renderer!.root
      .findAll((node) => String(node.type) === 'Pressable')
      .find((node) => textOf(node).includes('/server/app'))!
    await act(async () => serverRow.props.onPress())
    await act(async () => vi.advanceTimersByTimeAsync(BOTTOM_DRAWER_HIDE_DURATION_MS + 1))
    await flush()
    expect(
      request.mock.calls
        .filter(([method]) => method === 'repo.list')
        .some(
          ([, , options]) =>
            executionOptions.safeParse(options).data?.envelope.executionHost === 'runtime:server'
        )
    ).toBe(true)
    await act(async () =>
      renderer!.root
        .find(
          (node) =>
            String(node.type) === 'TextInput' &&
            node.props.placeholder === 'Type a name or search a source'
        )
        .props.onChangeText('Proof')
    )
    expect(pressable('Create worktree').props.disabled).toBe(false)
    await act(async () => pressable('Create worktree').props.onPress())
    await flush()
    const creates = request.mock.calls.filter(([method]) => method === 'worktree.create')
    expect(creates).toHaveLength(1)
    expect(creates[0]).toEqual([
      'worktree.create',
      expect.objectContaining({ repo: 'id:same' }),
      expect.objectContaining({ envelope: { executionHost: 'runtime:server' } })
    ])
    if (entrance === 'overlay') {
      expect(navigate).toHaveBeenCalledWith(
        expect.stringContaining('executionHost=runtime%3Aserver')
      )
      expect(fetch).toHaveBeenCalledWith({ allowDuringModal: true })
      expect(close).toHaveBeenCalledOnce()
    } else {
      expect(fixture.replace).toHaveBeenCalledWith(
        expect.stringContaining('executionHost=runtime%3Aserver')
      )
    }
    act(() => renderer!.unmount())
    renderer = undefined
    expect(events.size).toBe(0)
  }
)
