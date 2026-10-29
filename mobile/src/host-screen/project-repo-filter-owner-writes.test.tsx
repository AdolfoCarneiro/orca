// @vitest-environment happy-dom
import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { HostStatusGates } from '../transport/host-status-gates'
import type { HostPendingViewChanges } from './use-host-pending-view-changes'
import { RUNTIME_CAPABILITIES } from '../../../src/shared/protocol-version'
import { FakeLogicalClient } from '../transport/mobile-endpoint-supervisor-test-fakes'
import type { RpcResponse } from '../transport/types'

const foreground = vi.hoisted(() => ({ listeners: new Set<(state: string) => void>() }))
vi.mock('react-native', () => ({
  AppState: {
    addEventListener: (_event: string, listener: (state: string) => void) => {
      foreground.listeners.add(listener)
      return { remove: () => foreground.listeners.delete(listener) }
    }
  }
}))
vi.mock('../transport/host-app-version-store', () => ({ recordHostAppVersion: async () => {} }))
vi.mock('../transport/host-descriptor-recorder', () => ({
  recordHostDescriptorFromStatus: () => {}
}))
import { useHostStatusGates } from '../transport/host-status-gates'
import { useHostPendingViewChanges } from './use-host-pending-view-changes'

let root: Root | undefined
let container: HTMLElement | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  container?.remove()
  root = undefined
  expect(foreground.listeners.size).toBe(0)
})
const reply = (result: unknown): RpcResponse => ({
  id: 'reply',
  ok: true,
  result,
  _meta: { runtimeId: 'desktop' }
})

it.each([100, 1000])(
  'joins status recovery and %i wake/overwrite signals through actual pending dispatch and settlement',
  async (count) => {
    const client = new FakeLogicalClient('connected', 'lan')
    let malformed = true
    const sends: unknown[] = []
    let answer!: (reply: RpcResponse) => void
    client.sendRequest.mockImplementation(async (method, params) => {
      if (method === 'status.get') {
        return reply(malformed ? null : { capabilities: [...RUNTIME_CAPABILITIES] })
      }
      sends.push(params)
      return new Promise<RpcResponse>((resolve) => {
        answer = resolve
      })
    })
    let gates!: HostStatusGates
    let writer!: HostPendingViewChanges
    function Probe() {
      gates = useHostStatusGates({ client, hostId: 'desktop', connState: client.getState() })
      writer = useHostPendingViewChanges(
        client,
        gates.projectRepoFilterSupport,
        gates.statusGeneration
      )
      return null
    }
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(createElement(Probe)))
    expect(gates.projectRepoFilterSupport).toBe('unknown')
    await act(async () => {
      await writer.controls.sendView(
        { sortBy: 'name', filters: { filterRepoIds: ['old'] } },
        { sortBy: 'name', filterRepoIds: ['old'] },
        'exact'
      )
      for (let index = 0; index < count; index++) {
        await writer.controls.sendView(
          { filters: { filterRepoIds: [`new-${index}`] } },
          { filterRepoIds: [`new-${index}`] },
          'exact'
        )
      }
    })
    // Superseding only the filter releases surviving Sort; no stale filter or mode is sent with it.
    expect(sends).toEqual([{ sortBy: 'name' }])
    const sortAnswer = answer
    await act(async () => sortAnswer(reply({ ui: { sortBy: 'name' } })))
    expect(writer.status.pending).toHaveLength(1)
    malformed = false
    await act(async () => {
      for (let index = 0; index < count; index++) {
        foreground.listeners.forEach((listener) => listener('active'))
      }
    })
    expect(gates.projectRepoFilterSupport).toBe('exact')
    expect(sends).toEqual([
      { sortBy: 'name' },
      { filterRepoIds: [`new-${count - 1}`], filterRepoIdsMode: 'exact' }
    ])
    await act(async () => answer(reply({ ui: { filterRepoIds: [`new-${count - 1}`] } })))
    expect(writer.status.pending).toEqual([])
    // A burst during one active probe has at most one follow-up, and never installs filter capability lists.
    expect(
      client.sendRequest.mock.calls.filter(([method]) => method === 'status.get').length
    ).toBeLessThanOrEqual(3)
    expect(
      client.sendRequest.mock.calls.filter(
        ([method]) => method === 'runtime.clientCapabilities.update'
      )
    ).toHaveLength(0)
    const retainedControls = writer.controls
    let late!: Promise<unknown>
    await act(async () => {
      late = retainedControls.sendView(
        { filters: { filterRepoIds: ['late'] } },
        { filterRepoIds: ['late'] },
        'exact'
      )
    })
    const beforeRelease = client.sendRequest.mock.calls.length
    await act(async () => root!.unmount())
    root = undefined
    await act(async () => answer(reply({ ui: { filterRepoIds: ['late'] } })))
    await expect(late).resolves.toBe('waiting')
    await expect(
      retainedControls.sendView({ sortBy: 'recent' }, { sortBy: 'recent' })
    ).resolves.toBe('waiting')
    foreground.listeners.forEach((listener) => listener('active'))
    expect(client.sendRequest.mock.calls).toHaveLength(beforeRelease)
  }
)
