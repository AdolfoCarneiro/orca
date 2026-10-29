// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
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
  renderCounts.clear()
})
const local = { kind: 'local' } as const
const remote = { kind: 'environment', environmentId: 'crew-host' } as const
const renderCounts = new Map<string, number>()
function Pane({ party, target = local }: { party: string; target?: RuntimeClientTarget }) {
  renderCounts.set(party, (renderCounts.get(party) ?? 0) + 1)
  const crew = useOrchestrationCrew(target, party)
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
  const view = render(
    <>
      <Pane party="term_first" />
      <Pane party="term_other" />
    </>
  )
  await act(async () => {})
  expect(rig.streams).toHaveLength(2)
  act(() => {
    rig.streams[0].handlers.onEvent({ type: 'begin', status: 'ok' })
    rig.streams[0].handlers.onEvent({ type: 'complete' })
  })
  expect(view.getByTestId('term_first').textContent).toBe('0')
  const beforeOther = renderCounts.get('term_other')
  let complete = () => {}
  act(() => {
    complete = publish(0, true)
  })
  expect(view.getByTestId('term_first').textContent).toBe('0')
  act(complete)
  expect(view.getByTestId('term_first').textContent).toBe('1')
  expect(renderCounts.get('term_other')).toBe(beforeOther)
  const before = renderCounts.get('term_first') ?? 0
  act(() => publish(0, true)())
  expect(renderCounts.get('term_first')).toBe(before)
  act(() => publish(0, false)())
  expect(renderCounts.get('term_first')).toBe(before + 1)
  view.unmount()
  expect(rig.streams.every((stream) => stream.unsubscribe.mock.calls.length === 1)).toBe(true)
  expect(rig.listeners.size).toBe(0)
})

it('caches old-host refusal per generation and resubscribes after reconnect or pairing changes', async () => {
  replaceRuntimeEnvironmentRevisions([{ id: 'crew-host', createdAt: 1 }])
  const view = render(<Pane party="term_old" target={remote} />)
  await act(async () => {})
  act(() => rig.streams[0].handlers.onError({ code: 'method_not_found' }))
  expect(view.getByTestId('term_old').textContent).toBe('unknown')
  view.rerender(<Pane party="term_plain" target={remote} />)
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
  const parties = ['term_local_first', 'term_local_other', 'term_selected', 'term_other_host']
  const counts = () => parties.map((party) => renderCounts.get(party) ?? 0)
  const view = render(
    <>
      <Pane party="term_local_first" />
      <Pane party="term_local_other" />
      <Pane party="term_selected" target={remote} />
      <Pane party="term_other_host" target={otherHost} />
    </>
  )
  await act(async () => {})
  expect(rig.streams).toHaveLength(4)
  for (let index = 0; index < 4; index++) {
    act(() => publish(index)())
  }
  expect(counts().every((count) => count > 0)).toBe(true)
  renderCounts.clear()
  const expectNone = () => expect(counts()).toEqual([0, 0, 0, 0])

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
  expect(counts().slice(0, 3)).toEqual([0, 0, 0])
  expect(renderCounts.get('term_other_host')).toBeGreaterThan(0)
  expect(rig.streams).toHaveLength(5)
  renderCounts.clear()
  act(() =>
    replaceRuntimeEnvironmentRevisions([
      { id: 'crew-host', createdAt: 10 },
      { id: 'crew-other-host', createdAt: 20, pairingRevision: 21 }
    ])
  )
  await act(async () => {})
  expect(counts().slice(0, 3)).toEqual([0, 0, 0])
  expect(renderCounts.get('term_other_host')).toBeGreaterThan(0)
  expect(rig.streams).toHaveLength(6)
  renderCounts.clear()
  act(() => publish(5, true)())
  expect(counts()).toEqual([0, 0, 0, 1])
  renderCounts.clear()
  act(() => publish(2, true)())
  expect(counts()).toEqual([0, 0, 1, 0])
  expect(view.getByTestId('term_selected').textContent).toBe('1')
  expect(view.getByTestId('term_selected-question').textContent).toBe('Which option?')
  view.unmount()
})
