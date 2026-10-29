import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { useMobileAgentMessageNavigation } from './use-mobile-agent-message-navigation'
import { stubRpcClient } from '../transport/rpc-client-test-stub'
import type { AgentMessageSource } from '../../../src/shared/agent-session/agent-session-message-source'
import type { RpcResponse } from '../transport/types'

const from: AgentMessageSource = {
  kind: 'agent',
  orchestration: null,
  senders: [
    {
      name: 'Parser worker',
      party: { address: 'term_worker', terminalHandle: 'term_worker', orcaSessionId: null }
    }
  ]
}
const reply = (result: unknown): RpcResponse => ({ id: 'reply', ok: true, result })

it('resolves fresh on tap, opens a closed chat once, ignores old-server refusals and fences unmounts', async () => {
  let complete: (value: RpcResponse) => void = () => {}
  const sendRequest = vi.fn(
    (_method: string) =>
      new Promise<RpcResponse>((resolve) => {
        complete = resolve
      })
  )
  const client = stubRpcClient({ sendRequest })
  const navigate = vi.fn()
  let open: ReturnType<typeof useMobileAgentMessageNavigation> = () => {}
  function Probe() {
    open = useMobileAgentMessageNavigation(client, navigate)
    return null
  }
  let tree: ReactTestRenderer | null = null
  act(() => {
    tree = create(createElement(Probe))
  })
  try {
    open(from, from.senders[0])
    open(from, from.senders[0])
    expect(sendRequest).toHaveBeenCalledTimes(1)
    await act(async () => {
      complete(
        reply({ location: { kind: 'chat', sessionId: 'live', worktreeId: 'other-workspace' } })
      )
    })
    expect(sendRequest.mock.calls[1][0]).toBe('agentSession.reveal')
    await act(async () => {
      complete(reply({ ok: true }))
    })
    expect(navigate).toHaveBeenCalledTimes(1)
    expect(navigate.mock.calls[0][0]).toBe('other-workspace')
    open(from, from.senders[0])
    expect(sendRequest).toHaveBeenCalledTimes(3)
    await act(async () => {
      complete({ id: 'reply', ok: false, error: { code: 'forbidden', message: 'unsupported' } })
    })
    expect(navigate).toHaveBeenCalledTimes(1)
    open(from, from.senders[0])
    act(() => {
      tree?.unmount()
    })
    await act(async () => {
      complete(
        reply({ location: { kind: 'chat', sessionId: 'live', worktreeId: 'other-workspace' } })
      )
    })
    expect(navigate).toHaveBeenCalledTimes(1)
  } finally {
    act(() => tree?.unmount())
  }
})

it('opens the sending terminal leaf through caller-only focus and the phone inventory', async () => {
  const sendRequest = vi.fn(async (method: string) =>
    reply(
      method === 'orchestration.partyLocation'
        ? { location: { kind: 'terminal', handle: 'term_worker' } }
        : method === 'terminal.focus'
          ? { focus: { worktreeId: 'folder:workers' } }
          : {
              tabs: [
                {
                  type: 'terminal',
                  id: 'leaf-tab',
                  parentTabId: 'parent',
                  leafId: '11111111-1111-4111-8111-111111111111',
                  terminal: 'term_worker'
                }
              ]
            }
    )
  )
  const client = stubRpcClient({ sendRequest })
  const navigate = vi.fn()
  let open: ReturnType<typeof useMobileAgentMessageNavigation> = () => {}
  function Probe() {
    open = useMobileAgentMessageNavigation(client, navigate)
    return null
  }
  let tree: ReactTestRenderer | null = null
  act(() => {
    tree = create(createElement(Probe))
  })
  try {
    await act(async () => {
      open(from, from.senders[0])
    })
    expect(sendRequest).toHaveBeenCalledWith('terminal.focus', {
      terminal: 'term_worker',
      navigation: 'caller'
    })
    expect(navigate).toHaveBeenCalledWith(
      'folder:workers',
      'parent:11111111-1111-4111-8111-111111111111'
    )
  } finally {
    act(() => tree?.unmount())
  }
})
