import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BridgeInitRoute } from '../mobile-web-shell/bridge/bridge-envelope'
import type { MobileSessionTab } from './mobile-session-route-types'
import type { RpcClient } from '../transport/rpc-client'
import { stubRpcClient } from '../transport/rpc-client-test-stub'

type RouteUpdateListener = (route: BridgeInitRoute | null) => void

const bridge = vi.hoisted(() => {
  const held: {
    route: BridgeInitRoute | null
    listeners: RouteUpdateListener[]
    cleared: { param: string; value: string }[]
  } = { route: null, listeners: [], cleared: [] }
  return held
})

const page = {
  getShellSession: () => ({ route: bridge.route }),
  onRouteUpdate: (listener: RouteUpdateListener) => {
    bridge.listeners.push(listener)
    return () => {
      bridge.listeners = bridge.listeners.filter((held) => held !== listener)
    }
  },
  clearRouteParam: (param: string, value: string) => {
    bridge.cleared.push({ param, value })
    return true
  }
}
vi.mock('../transport/client-context.web', () => ({ usePageBridgeClient: () => page }))

import { useNotificationPaneNavigation } from './use-notification-pane-navigation'

// Use a real leaf id; invalid keys would test only the closed-pane path.
const LEAF = '11111111-1111-4111-8111-111111111111'

const TABS: MobileSessionTab[] = [
  {
    type: 'terminal',
    id: 'first',
    parentTabId: 'tab-a',
    leafId: LEAF,
    title: 'first',
    terminal: 'pty-a',
    isActive: true
  },
  {
    type: 'terminal',
    id: 'second',
    parentTabId: 'tab-b',
    leafId: LEAF,
    title: 'second',
    terminal: 'pty-b',
    isActive: false
  }
]

const switched: MobileSessionTab[] = []
const toast = vi.fn()
const trees: ReactTestRenderer[] = []
afterEach(() => {
  act(() => trees.splice(0).forEach((tree) => tree.unmount()))
  vi.useRealTimers()
})

const openImmediately = () => Promise.resolve(true)

function Probe({
  terminalsLoaded,
  sessionTabs = TABS,
  client = null,
  open = openImmediately
}: {
  terminalsLoaded: boolean
  sessionTabs?: MobileSessionTab[]
  client?: RpcClient | null
  open?: () => Promise<boolean>
}): null {
  useNotificationPaneNavigation({
    sessionTabs,
    terminalsLoaded,
    client,
    worktreeId: 'wt-1',
    showToast: toast,
    switchSessionTab: (tab) => {
      switched.push(tab)
      return open()
    }
  })
  return null
}

function render(terminalsLoaded: boolean, client: RpcClient | null = null): ReactTestRenderer {
  const rendered: { tree: ReactTestRenderer | null } = { tree: null }
  act(() => {
    rendered.tree = create(createElement(Probe, { terminalsLoaded, client }))
  })
  if (rendered.tree === null) {
    throw new Error('the probe did not render')
  }
  trees.push(rendered.tree)
  return rendered.tree
}

function deliver(paneKey: string): void {
  act(() => {
    for (const listener of bridge.listeners.slice()) {
      listener({ pathname: '/h/host-1/session/wt-1', params: { paneKey } })
    }
  })
}

beforeEach(() => {
  bridge.route = null
  bridge.listeners = []
  bridge.cleared.length = 0
  switched.length = 0
  toast.mockClear()
})

// Exercise the page hook: shell init carries pane requests because this document at / cannot edit the native route.
describe('the page pane hook', () => {
  it('switches to the pane the page was opened on, which arrives in the first init', () => {
    bridge.route = { pathname: '/h/host-1/session/wt-1', params: { paneKey: `tab-b:${LEAF}` } }
    render(true)
    expect(switched.map((tab) => tab.id)).toEqual(['second'])
  })

  it('holds that request until the terminals have loaded, rather than dropping it', () => {
    bridge.route = { pathname: '/h/host-1/session/wt-1', params: { paneKey: `tab-b:${LEAF}` } }
    const tree = render(false)
    expect(switched).toEqual([])
    act(() => {
      tree.update(createElement(Probe, { terminalsLoaded: true }))
    })
    expect(switched.map((tab) => tab.id)).toEqual(['second'])
  })

  it('erases the param that carried the pane it applied', () => {
    // Erase by value so an older acknowledgement cannot spend a newer notification tap.
    bridge.route = { pathname: '/h/host-1/session/wt-1', params: { paneKey: `tab-b:${LEAF}` } }
    render(true)
    expect(bridge.cleared).toEqual([{ param: 'paneKey', value: `tab-b:${LEAF}` }])
  })

  it('switches again for a repeat tap on the pane already showing', async () => {
    // A clear between identical values makes the later value a new request.
    render(true)
    deliver(`tab-a:${LEAF}`)
    await act(async () => {})
    deliver('')
    deliver(`tab-a:${LEAF}`)
    expect(switched.map((tab) => tab.id)).toEqual(['first', 'first'])
    expect(bridge.cleared).toEqual([
      { param: 'paneKey', value: `tab-a:${LEAF}` },
      { param: 'paneKey', value: `tab-a:${LEAF}` }
    ])
  })

  it('applies one pane once however many inits carry it', () => {
    // Replay must retry a lost clear without switching away from the user’s newer tab.
    render(true)
    deliver(`tab-a:${LEAF}`)
    deliver(`tab-a:${LEAF}`)
    expect(switched.map((tab) => tab.id)).toEqual(['first'])
    expect(bridge.cleared).toHaveLength(2)
  })

  it('applies successive pane requests and names each value when clearing', () => {
    render(true)
    deliver(`tab-a:${LEAF}`)
    deliver(`tab-b:${LEAF}`)
    expect(switched.map((tab) => tab.id)).toEqual(['first', 'second'])
    expect(bridge.cleared.map((entry) => entry.value)).toEqual([`tab-a:${LEAF}`, `tab-b:${LEAF}`])
  })

  it('asks for nothing and applies nothing when the route carries no pane', () => {
    // The shell’s erase returns as a route update, including on later ready replies.
    render(true)
    deliver(`tab-a:${LEAF}`)
    bridge.cleared.length = 0
    deliver('')
    expect(switched.map((tab) => tab.id)).toEqual(['first'])
    expect(bridge.cleared).toEqual([])
  })

  it('stays on the open tab for a pane that has since closed', () => {
    render(true)
    deliver(`gone:${LEAF}`)
    expect(switched).toEqual([])
    deliver('')
    expect(switched).toEqual([])
  })

  it('opens a pane missing from a list loaded before the push once a fresh list names it', () => {
    const tree = render(true)
    act(() => {
      tree.update(createElement(Probe, { terminalsLoaded: true, sessionTabs: [TABS[0]!] }))
    })
    deliver(`tab-b:${LEAF}`)
    expect(switched).toEqual([])
    act(() => {
      tree.update(createElement(Probe, { terminalsLoaded: true, sessionTabs: TABS }))
    })
    expect(switched.map((tab) => tab.id)).toEqual(['second'])
  })

  it('retains pending intent through ACK, expires it once, and allows an actual same-pane retry', async () => {
    vi.useFakeTimers()
    const tree = render(false)
    deliver(`tab-b:${LEAF}`)
    deliver('')
    act(() => {
      tree.update(createElement(Probe, { terminalsLoaded: true }))
    })
    expect(switched.map((tab) => tab.id)).toEqual(['second'])
    await act(async () => {})
    deliver(`gone:${LEAF}`)
    deliver('')
    act(() => vi.advanceTimersByTime(5000))
    expect(toast).toHaveBeenCalledOnce()
    act(() => {
      tree.update(
        createElement(Probe, {
          terminalsLoaded: true,
          sessionTabs: [...TABS, { ...TABS[1]!, id: 'late', parentTabId: 'gone' }]
        })
      )
    })
    expect(switched.map((tab) => tab.id)).toEqual(['second'])
    deliver(`gone:${LEAF}`)
    expect(switched.map((tab) => tab.id)).toEqual(['second', 'late'])
  })

  it('accepts a fresh same-pane request after logical cutover while old receipt awaits inventory', async () => {
    let generation = 1
    const client = stubRpcClient({ getGeneration: () => generation })
    const tree = render(false, client)
    deliver(`tab-b:${LEAF}`)
    deliver('')
    generation++
    deliver(`tab-b:${LEAF}`)
    expect(switched).toEqual([])
    await act(async () => {
      tree.update(createElement(Probe, { terminalsLoaded: true, client }))
    })
    expect(switched.map((tab) => tab.id)).toEqual(['second'])
    expect(toast).not.toHaveBeenCalled()
  })

  it('keeps a new generation receipt alive across stale completion and the old deadline', async () => {
    vi.useFakeTimers()
    let generation = 1
    const client = stubRpcClient({ getGeneration: () => generation })
    const completions: ((opened: boolean) => void)[] = []
    const open = () => new Promise<boolean>((resolve) => completions.push(resolve))
    let tree: ReactTestRenderer
    act(() => {
      tree = create(createElement(Probe, { terminalsLoaded: true, client, open }))
    })
    trees.push(tree!)
    deliver(`tab-b:${LEAF}`)
    deliver('')
    act(() => vi.advanceTimersByTime(1000))
    generation++
    deliver(`tab-b:${LEAF}`)
    expect(switched.map((tab) => tab.id)).toEqual(['second', 'second'])
    await act(async () => completions[0]!(false))
    act(() => vi.advanceTimersByTime(4000))
    expect(toast).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(1000))
    expect(toast).toHaveBeenCalledOnce()
    await act(async () => completions[1]!(false))
    expect(toast).toHaveBeenCalledOnce()
  })

  it('does nothing at all when the page was opened on no pane', () => {
    render(true)
    expect(switched).toEqual([])
  })
})
