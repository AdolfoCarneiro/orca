import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { useMobileAgentMessageNavigation } from './use-mobile-agent-message-navigation'
import { stubRpcClient } from '../transport/rpc-client-test-stub'
import type { AgentMessageSource } from '../../../src/shared/agent-session/agent-session-message-source'
import type { RpcResponse } from '../transport/types'
import type { SendRequestOptions } from '../transport/rpc-client'
import type { MobileSessionTab } from './mobile-session-route-types'
import { useNotificationPaneNavigation } from './use-notification-pane-navigation'
import { useMobileSessionTabSwitching } from './use-mobile-session-tab-switching'
import { mountFixture } from '../test-support/rpc-recording/recorder-fixture-shape'
import { MobileTerminalDiagnostics } from './mobile-terminal-diagnostics'
import { structuredAgentSessionPaneKey } from '../../../src/shared/structured-agent-session-projection'
import type { BridgeInitRoute } from '../mobile-web-shell/bridge/bridge-envelope'
import { resolveActiveSessionTab } from './active-session-tab'
import type { PendingSessionSelection } from './pending-session-selection'

const focus = vi.hoisted(() => ({ active: true }))
vi.mock('expo-router', async () => {
  const React = await import('react')
  return {
    useFocusEffect: (effect: () => () => void) =>
      React.useEffect(() => (focus.active ? effect() : undefined), [effect, focus.active])
  }
})
vi.mock('../platform/haptics', () => ({ triggerSelection: () => {} }))
const bridge: {
  route: BridgeInitRoute | null
  listener: (route: BridgeInitRoute | null) => void
  getShellSession: () => { route: BridgeInitRoute | null }
  onRouteUpdate: (listener: (route: BridgeInitRoute | null) => void) => () => void
  clearRouteParam: ReturnType<typeof vi.fn>
} = {
  route: null,
  listener: (_route: BridgeInitRoute | null) => {},
  getShellSession: () => ({ route: bridge.route }),
  onRouteUpdate: (listener: (route: BridgeInitRoute | null) => void) => {
    bridge.listener = listener
    return () => {
      bridge.listener = () => {}
    }
  },
  clearRouteParam: vi.fn()
}
vi.mock('../transport/client-context.web', () => ({ usePageBridgeClient: () => bridge }))
const from: AgentMessageSource = {
  kind: 'agent',
  orchestration: null,
  senders: [
    {
      name: 'Worker',
      party: { address: 'term_worker', terminalHandle: 'term_worker', orcaSessionId: null }
    }
  ]
}
const reply = (result: unknown): RpcResponse => ({ id: 'reply', ok: true, result })
const refused = (code: string): RpcResponse => ({
  id: 'reply',
  ok: false,
  error: { code, message: 'private diagnostic' }
})
const chat: MobileSessionTab = {
  type: 'agent-session',
  id: 'agent-session:live',
  sessionId: 'live',
  agent: 'codex',
  title: 'Worker',
  isActive: false
}
const leaf = '11111111-1111-4111-8111-111111111111'
const terminal: MobileSessionTab = {
  type: 'terminal',
  id: 'flattened',
  terminal: 'term_worker',
  parentTabId: 'parent',
  leafId: leaf,
  title: 'Worker',
  isActive: false
}
const trees: ReactTestRenderer[] = []
afterEach(() => {
  act(() => trees.splice(0).forEach((tree) => tree.unmount()))
  vi.useRealTimers()
  focus.active = true
  bridge.route = null
})

function mount(
  sendRequest: (
    method: string,
    params?: unknown,
    options?: SendRequestOptions
  ) => Promise<RpcResponse>
) {
  let generation = 1,
    sourceKey = 'source',
    destination: MobileSessionTab[] = []
  const client = stubRpcClient({ sendRequest, getGeneration: () => generation })
  const sourceSelection: Parameters<typeof useMobileAgentMessageNavigation>[4] = {
    activeSessionTabIdRef: { current: 'source' },
    selectedSessionTabIdRef: { current: null },
    sessionTabsRef: { current: [{ ...chat, id: 'source', isActive: true }] },
    pendingSelectionRef: { current: null }
  }
  const toast = vi.fn(),
    selected = vi.fn()
  const navigate = vi.fn((worktreeId: string, paneKey: string) => {
    bridge.route = { pathname: `/h/host/session/${worktreeId}`, params: { paneKey } }
    bridge.listener(bridge.route)
  })
  let open: ReturnType<typeof useMobileAgentMessageNavigation> = () => {}
  function Probe() {
    open = useMobileAgentMessageNavigation(client, navigate, sourceKey, toast, sourceSelection)
    const switching = useMobileSessionTabSwitching(
      mountFixture<Parameters<typeof useMobileSessionTabSwitching>[0]>({
        client,
        worktreeId: 'destination',
        sessionTabs: destination,
        activeSessionTabId: null,
        markdownDocs: new Map(),
        fileDocs: new Map(),
        readMarkdownTab: vi.fn(),
        readFileTab: vi.fn(),
        setActiveSessionTabId: selected,
        setActiveHandle: vi.fn(),
        switchSessionTabRef: { current: null },
        terminalDiagnosticsRef: { current: new MobileTerminalDiagnostics() },
        pendingSelectionRef: { current: null },
        activeSessionTabTypeRef: { current: null },
        activeHandleRef: { current: null },
        terminalUnsubsRef: { current: new Map() },
        defaultTerminalHandlesToLiveInput: vi.fn(),
        subscribeToTerminal: vi.fn(),
        unsubscribeTerminal: vi.fn(),
        showToast: toast
      })
    )
    useNotificationPaneNavigation({
      client,
      worktreeId: 'destination',
      sessionTabs: destination,
      terminalsLoaded: true,
      switchSessionTab: switching.switchSessionTab,
      showToast: toast
    })
    return null
  }
  let tree: ReactTestRenderer
  act(() => {
    tree = create(createElement(Probe))
  })
  trees.push(tree!)
  return {
    client,
    toast,
    navigate,
    selected,
    sourceSelection,
    openIdentity: () => open,
    open: (source = from) => open(source, source.senders[0]),
    redraw: (tabs = destination) => {
      destination = tabs
      act(() => tree!.update(createElement(Probe)))
    },
    replaceSource: () => {
      sourceKey += 'next'
      act(() => tree!.update(createElement(Probe)))
    },
    migrate: () => {
      generation++
    },
    unmount: () => act(() => tree!.unmount())
  }
}

it('retains the live displayed source before lookup, preserves newer intent, and keeps the opener stable', () => {
  const send = vi.fn((_method: string) => new Promise<RpcResponse>(() => {}))
  const h = mount(send)
  const refs = h.sourceSelection
  refs.activeSessionTabIdRef.current = 'fallback'
  refs.selectedSessionTabIdRef.current = 'closed'
  refs.sessionTabsRef.current = [{ ...chat, id: 'fallback', isActive: true }]
  const opener = h.openIdentity()
  act(() => h.open())
  expect(refs.selectedSessionTabIdRef.current).toBe('fallback')
  expect(send).toHaveBeenCalledOnce()
  expect(send.mock.calls[0]?.[0]).toBe('orchestration.partyLocation')
  const latePublication = [
    { ...chat, id: 'closed', isActive: true },
    ...refs.sessionTabsRef.current
  ]
  expect(
    resolveActiveSessionTab(latePublication, {
      pendingActiveSessionTabId: null,
      selectedSessionTabId: refs.selectedSessionTabIdRef.current
    }).activeTab?.id
  ).toBe('fallback')
  h.redraw()
  expect(h.openIdentity()).toBe(opener)
  for (const pending of [
    { kind: 'tab', tabId: 'newer' },
    { kind: 'terminal', handle: 'newer-handle', tabId: null },
    {
      kind: 'launched',
      lock: 'newer-launch',
      surface: { pane: null, sessionId: null, handle: null },
      snapshotsLeft: null
    }
  ] satisfies PendingSessionSelection[]) {
    refs.pendingSelectionRef.current = pending
    refs.selectedSessionTabIdRef.current = 'newer'
    h.replaceSource()
    act(() => h.open())
    expect(refs.pendingSelectionRef.current).toBe(pending)
    expect(refs.selectedSessionTabIdRef.current).toBe('newer')
  }
  refs.pendingSelectionRef.current = null
  refs.activeSessionTabIdRef.current = 'missing'
  h.replaceSource()
  act(() => h.open())
  expect(refs.selectedSessionTabIdRef.current).toBe('newer')
  expect(send).toHaveBeenCalledTimes(5)
  expect(h.navigate).not.toHaveBeenCalled()
})

it('uses record authority, passive caller reveal and actual destination inventory/activation, including delayed receipt', async () => {
  const send = vi.fn(async (method: string) =>
    reply(
      method === 'orchestration.partyLocation'
        ? { location: { kind: 'chat', sessionId: 'live', worktreeId: 'stale' } }
        : method === 'agentSession.reveal'
          ? {
              ok: true,
              sessionId: 'live',
              workspaceId: 'destination',
              agent: 'codex',
              readable: false
            }
          : method === 'session.tabs.list'
            ? { tabs: [chat] }
            : {}
    )
  )
  const h = mount(send)
  await act(async () => {
    h.open()
    h.open()
  })
  expect(send.mock.calls.map(([method]) => method)).toEqual([
    'orchestration.partyLocation',
    'agentSession.reveal',
    'session.tabs.list'
  ])
  expect(send.mock.calls[1]).toEqual([
    'agentSession.reveal',
    { sessionId: 'live', navigation: 'caller' },
    expect.objectContaining({ timeoutMs: expect.any(Number), budgetSpansConnect: true })
  ])
  expect(h.navigate).toHaveBeenCalledWith(
    'destination',
    structuredAgentSessionPaneKey(chat.id, 'live')
  )
  act(() => bridge.listener({ ...bridge.route!, params: {} }))
  expect(h.selected).not.toHaveBeenCalled()
  await act(async () => h.redraw([chat]))
  expect(h.selected).toHaveBeenCalledWith(chat.id)
  expect(send.mock.calls.at(-1)).toEqual([
    'session.tabs.activate',
    expect.objectContaining({ tabId: chat.id, navigation: 'caller', notifyClients: false })
  ])
  expect(h.toast).not.toHaveBeenCalled()
})

it.each(['forbidden', 'method_not_found'])(
  'keeps useful old-host direct terminal/chat paths after %s and never retries activating reveal',
  async (code) => {
    const send = vi.fn(async (method: string) =>
      method === 'orchestration.partyLocation' || method === 'agentSession.reveal'
        ? refused(code)
        : reply(
            method === 'terminal.focus'
              ? { focus: { worktreeId: 'destination' } }
              : method === 'session.tabs.listAll'
                ? { snapshots: [{ worktree: 'destination', tabs: [chat] }] }
                : { tabs: [terminal] }
          )
    )
    const h = mount(send)
    await act(async () => h.open())
    expect(h.navigate).toHaveBeenLastCalledWith('destination', `parent:${leaf}`)
    expect(send.mock.calls.find(([method]) => method === 'terminal.focus')).toEqual([
      'terminal.focus',
      { terminal: 'term_worker', navigation: 'caller' },
      expect.objectContaining({ budgetSpansConnect: true })
    ])
    const chatFrom: AgentMessageSource = {
      ...from,
      senders: [
        {
          ...from.senders[0],
          party: { address: 'orca:root', orcaSessionId: 'live', terminalHandle: null }
        }
      ]
    }
    await act(async () => h.open(chatFrom))
    expect(h.navigate).toHaveBeenLastCalledWith(
      'destination',
      structuredAgentSessionPaneKey(chat.id, 'live')
    )
    expect(send.mock.calls.some(([method]) => method === 'agentSession.reveal')).toBe(false)
  }
)

it('uses resolved live identity after a strict old reveal refusal, not the root or an activating retry', async () => {
  const send = vi.fn(async (method: string) =>
    method === 'agentSession.reveal'
      ? refused('invalid_argument')
      : reply(
          method === 'orchestration.partyLocation'
            ? { location: { kind: 'chat', sessionId: 'live', worktreeId: 'stale' } }
            : { snapshots: [{ worktree: 'destination', tabs: [chat] }] }
        )
  )
  const h = mount(send)
  await act(async () => h.open())
  expect(h.navigate).toHaveBeenCalledWith(
    'destination',
    structuredAgentSessionPaneKey(chat.id, 'live')
  )
  expect(send.mock.calls.filter(([method]) => method === 'agentSession.reveal')).toHaveLength(1)
})

it('coalesces only current identical evidence, lets A/B/A progress, and fences source/visit/generation/unmount', async () => {
  const pending: ((value: RpcResponse) => void)[] = []
  const send = vi.fn(() => new Promise<RpcResponse>((resolve) => pending.push(resolve)))
  const h = mount(send)
  h.open()
  h.open()
  expect(pending).toHaveLength(1)
  h.open({
    ...from,
    senders: [{ ...from.senders[0], party: { ...from.senders[0].party, address: 'term_b' } }]
  })
  h.open()
  expect(pending).toHaveLength(3)
  h.replaceSource()
  await act(async () =>
    pending.splice(0).forEach((resolve) => resolve(reply({ location: null, lost: 'terminal' })))
  )
  expect(h.toast).not.toHaveBeenCalled()
  h.open()
  h.migrate()
  await act(async () => pending.shift()!(reply({ location: null, lost: 'chat' })))
  expect(h.toast).not.toHaveBeenCalled()
  h.open()
  focus.active = false
  h.redraw()
  focus.active = true
  h.redraw()
  await act(async () => pending.shift()!(reply({ location: null })))
  expect(h.toast).not.toHaveBeenCalled()
  h.open()
  h.unmount()
  await act(async () =>
    pending.shift()!(reply({ location: { kind: 'terminal', handle: 'term_worker' } }))
  )
  expect(h.navigate).not.toHaveBeenCalled()
})

it.each([
  [{ location: null, lost: 'chat' }, 'no longer on this host'],
  [{ location: null, lost: 'terminal' }, "Agent's pane is no longer available"],
  [{ location: null }, "couldn't reach the agent"],
  [{ location: { kind: 'future' } }, 'newer Orca']
])('settles %j honestly and permits a fresh retry', async (result, text) => {
  const send = vi.fn(async () => reply(result)),
    h = mount(send)
  await act(async () => h.open())
  expect(h.toast.mock.calls[0][0]).toContain(text)
  await act(async () => h.open())
  expect(send).toHaveBeenCalledTimes(2)
})

it('budgets connection and response stages against one attempt deadline and retires timeout for retry', async () => {
  vi.useFakeTimers()
  const send = vi.fn(
    (_method: string, _params?: unknown, options?: SendRequestOptions) =>
      new Promise<RpcResponse>((_resolve, reject) =>
        setTimeout(() => reject(new Error('transport timeout')), options?.timeoutMs)
      )
  )
  const h = mount(send)
  h.open()
  expect(send.mock.calls[0][2]).toEqual({ timeoutMs: 5000, budgetSpansConnect: true })
  await act(async () => vi.advanceTimersByTimeAsync(5000))
  expect(h.toast).toHaveBeenCalledOnce()
  h.open()
  expect(send).toHaveBeenCalledTimes(2)
})

it('reports destination activation failure once through the real receiving switch', async () => {
  const send = vi.fn(async (method: string) =>
    method === 'session.tabs.activate'
      ? refused('unavailable')
      : reply(
          method === 'orchestration.partyLocation'
            ? { location: { kind: 'chat', sessionId: 'live', worktreeId: 'destination' } }
            : method === 'agentSession.reveal'
              ? {
                  ok: true,
                  sessionId: 'live',
                  workspaceId: 'destination',
                  agent: 'codex',
                  readable: true
                }
              : { tabs: [chat] }
        )
  )
  const h = mount(send)
  h.redraw([chat])
  await act(async () => h.open())
  expect(h.selected).toHaveBeenCalledWith(chat.id)
  expect(send.mock.calls.map(([method]) => method)).toContain('session.tabs.activate')
  expect(h.toast).toHaveBeenCalledOnce()
})
