import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import * as catalogs from '../../../src/shared/native-chat-discovered-catalog-models'
import { useMobileNativeChatModelDiscovery } from './use-mobile-native-chat-model-discovery'
import type { RpcResponse } from '../transport/types'

type Args = Parameters<typeof useMobileNativeChatModelDiscovery>[0]
let renderer: ReactTestRenderer | undefined
let models: ReturnType<typeof useMobileNativeChatModelDiscovery>
function Probe({ args }: { args: Args }): null {
  models = useMobileNativeChatModelDiscovery(args)
  return null
}
function response(count: number, prefix: string): RpcResponse {
  return {
    id: 'discovery',
    ok: true,
    result: {
      success: true,
      catalogOrigin: 'probe',
      models: Array.from({ length: count }, (_, index) => ({
        id: `${prefix}/${index}`,
        label: `${prefix} ${index}`,
        thinkingLevels: [{ id: 'high', label: 'High' }]
      }))
    },
    _meta: { runtimeId: 'host' }
  }
}
function pendingDiscovery(): {
  args: Args
  complete: (value: RpcResponse) => void
} {
  let complete = (_value: RpcResponse): void => {
    throw new Error('request has not started')
  }
  const pending = new Promise<RpcResponse>((resolve) => {
    complete = resolve
  })
  return {
    args: {
      client: { sendRequest: vi.fn(() => pending) },
      agent: 'claude',
      hostId: 'old-host',
      worktreeId: 'folder:workspace',
      enabled: true
    },
    complete
  }
}
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = undefined
  vi.restoreAllMocks()
})

it.each([10, 100])('does not project %i late models after unmount', async (count) => {
  const projection = vi.spyOn(catalogs, 'catalogModelsFromModelDiscovery')
  const pending = pendingDiscovery()
  await act(async () => {
    renderer = create(createElement(Probe, { args: pending.args }))
  })
  await act(async () => renderer?.unmount())
  renderer = undefined
  await act(async () => pending.complete(response(count, 'obsolete')))

  expect(projection).not.toHaveBeenCalled()
})

it.each([10, 100])('keeps the live successor while skipping %i obsolete models', async (count) => {
  const projection = vi.spyOn(catalogs, 'catalogModelsFromModelDiscovery')
  const pending = pendingDiscovery()
  await act(async () => {
    renderer = create(createElement(Probe, { args: pending.args }))
  })
  const next: Args = {
    ...pending.args,
    hostId: 'new-host',
    client: { sendRequest: vi.fn(async () => response(1, 'live')) }
  }
  await act(async () => renderer?.update(createElement(Probe, { args: next })))
  expect(models?.map((model) => model.id)).toEqual(['live/0'])
  const live = models
  projection.mockClear()
  await act(async () => pending.complete(response(count, 'obsolete')))

  expect(projection).not.toHaveBeenCalled()
  expect(models).toBe(live)
})
