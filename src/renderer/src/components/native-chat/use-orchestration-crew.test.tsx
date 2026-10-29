// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { useLayoutEffect } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { RuntimeRpcSubscriptionHandlers } from '@/runtime/runtime-rpc-subscribe'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import { useOrchestrationCrew } from './use-orchestration-crew'

const rig = vi.hoisted(() => {
  const streams: {
    target: RuntimeClientTarget
    party: string
    handlers: RuntimeRpcSubscriptionHandlers
    unsubscribe: ReturnType<typeof vi.fn>
  }[] = []
  return {
    streams,
    listeners: new Set<() => void>(),
    state: {
      unusedLocalState: 0,
      runtimeStatusByEnvironmentId: new Map([
        [
          'crew-host',
          { status: { runtimeId: 'runtime-one' }, connectionGeneration: 1, hostContactEpoch: 1 }
        ]
      ])
    }
  }
})
vi.mock('@/runtime/runtime-rpc-subscribe', () => ({
  subscribeRuntimeRpc: vi.fn(
    async (
      target: RuntimeClientTarget,
      _method: string,
      params: { party: string },
      handlers: RuntimeRpcSubscriptionHandlers
    ) => {
      const stream = { target, party: params.party, handlers, unsubscribe: vi.fn() }
      rig.streams.push(stream)
      return { unsubscribe: stream.unsubscribe }
    }
  )
}))
vi.mock('@/store', async () => {
  const { useSyncExternalStore } = await import('react')
  return {
    useAppStore: (select: (state: typeof rig.state) => unknown) =>
      useSyncExternalStore(
        (wake) => {
          rig.listeners.add(wake)
          return () => rig.listeners.delete(wake)
        },
        () => select(rig.state)
      )
  }
})
afterEach(() => {
  cleanup()
  rig.streams.length = 0
})
const local = { kind: 'local' } as const
const remote = { kind: 'environment', environmentId: 'crew-host' } as const
function Pane({
  party,
  target = local,
  renderCount
}: {
  party: string
  target?: RuntimeClientTarget
  renderCount: () => void
}) {
  const crew = useOrchestrationCrew(target, party)
  useLayoutEffect(() => {
    renderCount()
  })
  return (
    <>
      <output data-testid={party}>
        {crew.status === 'ok' ? crew.sections.managing.length : 'unknown'}
      </output>
      <output data-testid={`${party}-question`}>
        {crew.sections.managing[0]?.pendingQuestion?.preview}
      </output>
    </>
  )
}
function publish(index: number, pending = false) {
  const handlers = rig.streams[index].handlers
  handlers.onEvent({ type: 'begin', status: 'ok' })
  handlers.onEvent({
    type: 'rows',
    section: 'managing',
    rows: [
      {
        partyKey: 'host-worker',
        role: 'worker',
        label: 'Worker',
        agentKind: 'codex',
        status: 'working',
        sendAddress: 'term_worker',
        ...(pending
          ? { pendingQuestion: { preview: 'Which option?', at: new Date(0).toISOString() } }
          : {})
      }
    ]
  })
  return () => handlers.onEvent({ type: 'complete' })
}

it('retains the collapsed/no-crew wake, publishes only complete replacements and isolates parties', async () => {
  const first = vi.fn(),
    other = vi.fn()
  const view = render(
    <>
      <Pane party="term_first" renderCount={first} />
      <Pane party="term_other" renderCount={other} />
    </>
  )
  await act(async () => {})
  expect(rig.streams).toHaveLength(2)
  act(() => {
    rig.streams[0].handlers.onEvent({ type: 'begin', status: 'ok' })
    rig.streams[0].handlers.onEvent({ type: 'complete' })
  })
  expect(view.getByTestId('term_first').textContent).toBe('0')
  const beforeOther = other.mock.calls.length
  let complete = () => {}
  act(() => {
    complete = publish(0, true)
  })
  expect(view.getByTestId('term_first').textContent).toBe('0')
  act(complete)
  expect(view.getByTestId('term_first').textContent).toBe('1')
  expect(other).toHaveBeenCalledTimes(beforeOther)
  const before = first.mock.calls.length
  act(() => publish(0, true)())
  expect(first).toHaveBeenCalledTimes(before)
  act(() => publish(0, false)())
  expect(first).toHaveBeenCalledTimes(before + 1)
  view.unmount()
  expect(rig.streams.every((stream) => stream.unsubscribe.mock.calls.length === 1)).toBe(true)
  expect(rig.listeners.size).toBe(0)
})

it('caches old-host refusal per generation and resubscribes after reconnect or pairing changes', async () => {
  replaceRuntimeEnvironmentRevisions([{ id: 'crew-host', createdAt: 1 }])
  const view = render(<Pane party="term_old" target={remote} renderCount={vi.fn()} />)
  await act(async () => {})
  act(() => rig.streams[0].handlers.onError({ code: 'method_not_found' }))
  expect(view.getByTestId('term_old').textContent).toBe('unknown')
  view.rerender(<Pane party="term_plain" target={remote} renderCount={vi.fn()} />)
  await act(async () => {})
  expect(rig.streams).toHaveLength(1)
  act(() => {
    rig.state = {
      ...rig.state,
      runtimeStatusByEnvironmentId: new Map([
        [
          'crew-host',
          { status: { runtimeId: 'runtime-two' }, connectionGeneration: 2, hostContactEpoch: 2 }
        ]
      ])
    }
    rig.listeners.forEach((wake) => wake())
  })
  await act(async () => {})
  expect(rig.streams).toHaveLength(2)
  act(() => publish(1)())
  expect(view.getByTestId('term_plain').textContent).toBe('1')
  act(() => rig.streams[1].handlers.onClose())
  expect(view.getByTestId('term_plain').textContent).toBe('unknown')
  act(() =>
    replaceRuntimeEnvironmentRevisions([{ id: 'crew-host', createdAt: 1, pairingRevision: 2 }])
  )
  await act(async () => {})
  expect(rig.streams).toHaveLength(3)
  expect(rig.streams[1].unsubscribe).toHaveBeenCalledOnce()
  view.unmount()
  expect(rig.streams[2].unsubscribe).toHaveBeenCalledOnce()
})

it('renders no unaffected local parties or hosts after unused state and other-host updates', async () => {
  const otherHost = { kind: 'environment', environmentId: 'crew-other-host' } as const
  const status = {
    status: { runtimeId: 'runtime-isolation' },
    connectionGeneration: 1,
    hostContactEpoch: 1
  }
  rig.state = {
    unusedLocalState: 0,
    runtimeStatusByEnvironmentId: new Map([
      ['crew-host', status],
      ['crew-other-host', status]
    ])
  }
  replaceRuntimeEnvironmentRevisions([
    { id: 'crew-host', createdAt: 10 },
    { id: 'crew-other-host', createdAt: 20 }
  ])
  const localFirst = vi.fn(),
    localOther = vi.fn(),
    selected = vi.fn(),
    other = vi.fn()
  const counts = [localFirst, localOther, selected, other]
  const view = render(
    <>
      <Pane party="term_local_first" renderCount={localFirst} />
      <Pane party="term_local_other" renderCount={localOther} />
      <Pane party="term_selected" target={remote} renderCount={selected} />
      <Pane party="term_other_host" target={otherHost} renderCount={other} />
    </>
  )
  await act(async () => {})
  expect(rig.streams).toHaveLength(4)
  for (let index = 0; index < 4; index++) {
    act(() => publish(index)())
  }
  counts.forEach((count) => count.mockClear())
  const expectNone = () => counts.forEach((count) => expect(count).not.toHaveBeenCalled())

  act(() => {
    rig.state = { ...rig.state, unusedLocalState: 1 }
    rig.listeners.forEach((wake) => wake())
  })
  expectNone()
  act(() => {
    rig.state = {
      ...rig.state,
      runtimeStatusByEnvironmentId: new Map(rig.state.runtimeStatusByEnvironmentId).set(
        'crew-other-host',
        { ...status, connectionGeneration: 2 }
      )
    }
    rig.listeners.forEach((wake) => wake())
  })
  await act(async () => {})
  expect(localFirst).not.toHaveBeenCalled()
  expect(localOther).not.toHaveBeenCalled()
  expect(selected).not.toHaveBeenCalled()
  expect(other).toHaveBeenCalled()
  expect(rig.streams).toHaveLength(5)
  counts.forEach((count) => count.mockClear())
  act(() =>
    replaceRuntimeEnvironmentRevisions([
      { id: 'crew-host', createdAt: 10 },
      { id: 'crew-other-host', createdAt: 20, pairingRevision: 21 }
    ])
  )
  await act(async () => {})
  expect(localFirst).not.toHaveBeenCalled()
  expect(localOther).not.toHaveBeenCalled()
  expect(selected).not.toHaveBeenCalled()
  expect(other).toHaveBeenCalled()
  expect(rig.streams).toHaveLength(6)
  counts.forEach((count) => count.mockClear())
  act(() => publish(5, true)())
  expect(localFirst).not.toHaveBeenCalled()
  expect(localOther).not.toHaveBeenCalled()
  expect(selected).not.toHaveBeenCalled()
  expect(other).toHaveBeenCalledOnce()
  counts.forEach((count) => count.mockClear())
  act(() => publish(2, true)())
  expect(selected).toHaveBeenCalledOnce()
  expect(localFirst).not.toHaveBeenCalled()
  expect(localOther).not.toHaveBeenCalled()
  expect(other).not.toHaveBeenCalled()
  expect(view.getByTestId('term_selected').textContent).toBe('1')
  expect(view.getByTestId('term_selected-question').textContent).toBe('Which option?')
  view.unmount()
})
