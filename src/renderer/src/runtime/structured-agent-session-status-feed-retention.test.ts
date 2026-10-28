import { setImmediate } from 'node:timers/promises'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type {
  AgentSessionStatusEvent,
  AgentSessionStatusSummary
} from '../../../shared/agent-session-wire'
import { publicRuntimeEnvironment } from './paired-runtime-environment-test-fixture'
import { createRuntimeStatusTestStore } from '../store/slices/runtime-status.test-fixture'
import { resetDeferredPeerChecksForTests } from '../store/slices/runtime-environment-peer-replacement'
import {
  getStructuredAgentSessionStatusFeed,
  resetStructuredAgentSessionStatusFeedsForTests
} from './structured-agent-session-status-feed'

const mocks = vi.hoisted(() => ({ subscribe: vi.fn() }))
vi.mock('./structured-agent-session-client', () => ({
  subscribeStructuredAgentSessionStatus: mocks.subscribe
}))
vi.mock('sonner', () => ({ toast: { warning: vi.fn(), dismiss: vi.fn() } }))

const target = { kind: 'environment', environmentId: 'retired' } as const
const localTarget = { kind: 'local' } as const
const session: AgentSessionStatusSummary = {
  sessionId: 'session',
  workspaceId: 'folder:workspace',
  agent: 'codex',
  status: 'working',
  latestPrompt: 'retired prompt',
  updatedAt: 1,
  hostExecutionOwned: true
}
const subscriptions: {
  emit: (event: AgentSessionStatusEvent) => void
  unsubscribe: ReturnType<typeof vi.fn>
}[] = []

function subscription(index = 0) {
  const entry = subscriptions[index]
  if (!entry) {
    throw new Error('Expected a real feed subscription')
  }
  return entry
}

beforeEach(async () => {
  vi.stubGlobal('window', { api: {}, dispatchEvent: vi.fn() })
  resetDeferredPeerChecksForTests()
  subscriptions.length = 0
  mocks.subscribe.mockReset()
  mocks.subscribe.mockImplementation((_target, emit: (event: AgentSessionStatusEvent) => void) => {
    const unsubscribe = vi.fn(() => emit({ type: 'end' }))
    subscriptions.push({ emit, unsubscribe })
    return Promise.resolve({ unsubscribe })
  })
  const rpc = await import('./runtime-rpc-client')
  vi.spyOn(rpc, 'runtimeEnvironmentSupportsCapability').mockResolvedValue(true)
})

afterEach(() => {
  resetStructuredAgentSessionStatusFeedsForTests()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function removeHosts(count: number) {
  const store = createRuntimeStatusTestStore()
  const environments = Array.from({ length: count }, (_, index) =>
    publicRuntimeEnvironment({ id: `retired-${index}` })
  )
  const survivor = publicRuntimeEnvironment({ id: 'survivor' })
  store.getState().setRuntimeEnvironments([...environments, survivor])
  const retired = environments.map(
    (environment) =>
      new WeakRef(
        getStructuredAgentSessionStatusFeed({ kind: 'environment', environmentId: environment.id })
      )
  )
  const live = getStructuredAgentSessionStatusFeed({
    kind: 'environment',
    environmentId: survivor.id
  })
  const local = getStructuredAgentSessionStatusFeed(localTarget)
  store.getState().setRuntimeEnvironments([survivor])
  return { store, retired, live, local }
}

it.each([10, 100])('releases feed owners after %i paired hosts are removed', async (count) => {
  const { store, retired, live, local } = removeHosts(count)
  expect(store.getState().runtimeEnvironments.map((environment) => environment.id)).toEqual([
    'survivor'
  ])
  expect(store.getState().removedRuntimeEnvironmentIds.size).toBe(count)
  if (typeof globalThis.gc !== 'function') {
    throw new Error('Run with the Vitest --expose-gc config')
  }
  for (let round = 0; round < 3; round += 1) {
    await setImmediate()
    globalThis.gc()
  }
  expect(retired.filter((owner) => owner.deref() !== undefined)).toHaveLength(0)
  expect(
    getStructuredAgentSessionStatusFeed({ kind: 'environment', environmentId: 'survivor' })
  ).toBe(live)
  expect(getStructuredAgentSessionStatusFeed(localTarget)).toBe(local)
})

it.each(['listener', 'activation'] as const)(
  'preserves a feed with a live %s across same-ID removal and recreation',
  async (consumer) => {
    vi.useFakeTimers()
    const store = createRuntimeStatusTestStore()
    store
      .getState()
      .setRuntimeEnvironments([publicRuntimeEnvironment({ id: target.environmentId })])
    const feed = getStructuredAgentSessionStatusFeed(target)
    const release = consumer === 'listener' ? feed.subscribe(() => {}) : feed.activate()
    await vi.advanceTimersByTimeAsync(0)
    store.getState().setRuntimeEnvironments([])
    expect(getStructuredAgentSessionStatusFeed(target)).toBe(feed)
    store
      .getState()
      .setRuntimeEnvironments([publicRuntimeEnvironment({ id: target.environmentId })])
    expect(getStructuredAgentSessionStatusFeed(target)).toBe(feed)
    if (consumer === 'activation') {
      subscription().emit({
        type: 'status',
        session: { ...session, latestPrompt: 'new observation' }
      })
      expect(feed.getSnapshot().get(session.sessionId)?.latestPrompt).toBe('new observation')
      expect(subscription().unsubscribe).not.toHaveBeenCalled()
    }
    release()
  }
)

it('drops dormant history after workspace purge and starts fresh when the host returns', async () => {
  vi.useFakeTimers()
  const store = createRuntimeStatusTestStore()
  store.getState().setRuntimeEnvironments([publicRuntimeEnvironment({ id: target.environmentId })])
  const feed = getStructuredAgentSessionStatusFeed(target)
  const release = feed.activate()
  await vi.advanceTimersByTimeAsync(0)
  subscription().emit({ type: 'snapshot', sessions: [session] })
  release()
  expect(feed.getSnapshot().get(session.sessionId)?.latestPrompt).toBe(session.latestPrompt)
  expect(subscription().unsubscribe).toHaveBeenCalledOnce()
  store.setState({
    purgeStaleRuntimeHostState: () => expect(getStructuredAgentSessionStatusFeed(target)).toBe(feed)
  })
  store.getState().setRuntimeEnvironments([])
  store.getState().setRuntimeEnvironments([publicRuntimeEnvironment({ id: target.environmentId })])
  const recreated = getStructuredAgentSessionStatusFeed(target)
  expect(recreated).not.toBe(feed)
  expect(recreated.getSnapshot().size).toBe(0)
  recreated.activate()
  await vi.advanceTimersByTimeAsync(0)
  subscription(1).emit({ type: 'status', session: { ...session, latestPrompt: 'fresh history' } })
  subscription().emit({ type: 'status', session })
  expect(recreated.getSnapshot().get(session.sessionId)?.latestPrompt).toBe('fresh history')
})

it('preserves ordinary catalog refresh, temporary status loss and proven same-host rotation', () => {
  const store = createRuntimeStatusTestStore()
  const environment = publicRuntimeEnvironment({
    id: target.environmentId,
    pairingRevision: 1,
    hostKeyFingerprint: 'host-a'
  })
  store.getState().setRuntimeEnvironments([environment])
  const feed = getStructuredAgentSessionStatusFeed(target)
  store.getState().setRuntimeEnvironments(structuredClone([environment]))
  store.getState().clearRuntimeEnvironmentStatus(target.environmentId)
  store.getState().setRuntimeEnvironments([{ ...environment, pairingRevision: 2 }])
  expect(getStructuredAgentSessionStatusFeed(target)).toBe(feed)
})

it('evicts a dormant feed when a same-ID pairing names another machine', () => {
  const store = createRuntimeStatusTestStore()
  const environment = publicRuntimeEnvironment({
    id: target.environmentId,
    pairingRevision: 1,
    hostKeyFingerprint: 'host-a'
  })
  store.getState().setRuntimeEnvironments([environment])
  const feed = getStructuredAgentSessionStatusFeed(target)
  store
    .getState()
    .setRuntimeEnvironments([{ ...environment, pairingRevision: 2, hostKeyFingerprint: 'host-b' }])
  expect(getStructuredAgentSessionStatusFeed(target)).not.toBe(feed)
})
