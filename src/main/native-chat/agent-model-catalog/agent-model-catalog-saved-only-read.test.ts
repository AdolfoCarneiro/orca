import type { AgentModelCatalogContext } from './agent-model-catalog-service-contract'
import { agentSessionConversationView } from '../../../shared/agent-session-conversation-view'
import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionAccountHome } from '../../../shared/agent-session-account-home'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../shared/agent-session-record.test-fixture'
import { agentModelCatalogFingerprint } from './agent-model-catalog-fingerprint'
import { createAgentModelCatalogService } from './agent-model-catalog-service'
import {
  AGENT_MODEL_CATALOG_FAILURE_TTL_MS,
  AGENT_MODEL_CATALOG_FRESH_MS,
  AgentModelCatalogStore,
  type AgentModelCatalogSuccess
} from './agent-model-catalog-store'
import { AgentModelCatalogUnavailableError } from './agent-model-catalog-unavailable'
import { agentReadsProjectModelConfig } from './agent-project-model-override'

const HOME = { variable: 'GROK_HOME', path: '/homes/grok' } as const
const FINGERPRINT = agentModelCatalogFingerprint({
  agent: 'grok',
  accountHome: HOME,
  wslDistro: null
})
const SIGNED_OUT = { reason: 'notSignedIn', account: 'system' } as const

function listing(id: string): AgentModelCatalogSuccess {
  return {
    models: [{ id, label: id, isDefault: true, efforts: [] }],
    origin: 'probe'
  }
}

function rig(agent = 'grok') {
  let now = 1_000
  const store = new AgentModelCatalogStore({ now: () => now })
  const probe = vi.fn(
    (_home: AgentSessionAccountHome) => new Promise<AgentModelCatalogSuccess>(() => {})
  )
  const service = createAgentModelCatalogService({
    store,
    getConversation: () => undefined,
    getRecord: () => undefined,
    drivesRecord: () => true,
    resolveAccountHome: async () => HOME,
    probes: { [agent]: probe },
    listingNamesConfiguredModel: new Set(['grok']),
    agentReadsProjectModelConfig
  })
  return { store, probe, service, advance: (ms: number) => (now += ms) }
}

describe('a saved-only catalog read', () => {
  it('does not relaunch a released chat to read models after startup failed', async () => {
    let now = 1_000
    const record = {
      ...agentSessionRecordFixture(
        agentSessionLeaseFixture({
          claimStatus: 'released',
          ownerProcess: null,
          deathEvidence: {
            kind: 'pid-absent',
            detail: 'reservation failed before spawn',
            observedAt: now,
            ownerFence: 6
          }
        })
      ),
      provider: 'grok',
      accountHome: HOME
    }
    const store = new AgentModelCatalogStore({ now: () => now })
    const probe = vi.fn(async () => listing('grok-4.7'))
    const resolveAccountHome = vi.fn(async () => HOME)
    const service = createAgentModelCatalogService({
      store,
      getConversation: (sessionId) => {
        const saved = sessionId === record.sessionId ? record : undefined
        return saved ? agentSessionConversationView(saved) : undefined
      },
      getRecord: () => undefined,
      drivesRecord: () => true,
      resolveAccountHome,
      probes: { grok: probe }
    })

    expect(
      await service.read({ agent: 'grok', sessionId: record.sessionId, waitForListing: true })
    ).toEqual({
      origin: 'unknown'
    })
    expect(probe).not.toHaveBeenCalled()

    store.recordSuccess(FINGERPRINT, 'grok', listing('grok-4.7'), 'discovery')
    now += AGENT_MODEL_CATALOG_FRESH_MS
    expect(await service.read({ agent: 'grok', sessionId: record.sessionId })).toMatchObject({
      origin: 'probe',
      models: [{ id: 'grok-4.7' }]
    })
    expect(probe).not.toHaveBeenCalled()

    expect(resolveAccountHome).not.toHaveBeenCalled()
    await service.read({ agent: 'grok' })
    expect(probe).toHaveBeenCalledOnce()
  })

  it('answers from the saved entry and starts nothing, however old the entry is', async () => {
    const { store, probe, service, advance } = rig()
    store.recordSuccess(FINGERPRINT, 'grok', listing('grok-4.7'), 'discovery')
    advance(AGENT_MODEL_CATALOG_FRESH_MS)
    const result = await service.read({ agent: 'grok', savedOnly: true })
    expect(result).toMatchObject({ origin: 'probe', models: [{ id: 'grok-4.7' }] })
    expect(result).not.toHaveProperty('listingInProgress')
    expect(store.pendingListing(FINGERPRINT)).toBeNull()
    expect(probe).not.toHaveBeenCalled()
    await service.read({ agent: 'grok' })
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('answers unknown with nothing saved, and starts no listing for it', async () => {
    const { store, probe, service } = rig()
    expect(await service.read({ agent: 'grok', savedOnly: true })).toEqual({ origin: 'unknown' })
    expect(store.pendingListing(FINGERPRINT)).toBeNull()
    expect(probe).not.toHaveBeenCalled()
  })

  it('carries a held reason without re-checking it past its TTL', async () => {
    const { store, probe, service, advance } = rig()
    await store
      .refresh(FINGERPRINT, 'grok', probe, () =>
        Promise.reject(new AgentModelCatalogUnavailableError(SIGNED_OUT))
      )
      .catch(() => undefined)
    advance(AGENT_MODEL_CATALOG_FAILURE_TTL_MS)
    expect(await service.read({ agent: 'grok', savedOnly: true })).toEqual({
      origin: 'unknown',
      unavailable: SIGNED_OUT
    })
    expect(probe).not.toHaveBeenCalled()
  })

  it('says the named default holds in every workspace only for an agent no project config moves', async () => {
    const grok = rig('grok')
    grok.store.recordSuccess(FINGERPRINT, 'grok', listing('grok-4.7'), 'discovery')
    expect(await grok.service.read({ agent: 'grok', savedOnly: true })).toMatchObject({
      listingNamesConfiguredModel: true,
      defaultHoldsInEveryWorkspace: true
    })
    // Project config can pick OpenCode's default even when model listings name none.
    const opencode = rig('opencode')
    const opencodeKey = agentModelCatalogFingerprint({
      agent: 'opencode',
      accountHome: HOME,
      wslDistro: null
    })
    opencode.store.recordSuccess(opencodeKey, 'opencode', listing('a/b'), 'discovery')
    expect(await opencode.service.read({ agent: 'opencode', savedOnly: true })).not.toHaveProperty(
      'defaultHoldsInEveryWorkspace'
    )
  })
})

it('keeps saved-only reads exact and active associations bounded to their immutable owner', async () => {
  const saved = agentSessionRecordFixture(agentSessionLeaseFixture())
  saved.provider = 'codex'
  saved.accountHome = { variable: 'CODEX_HOME', path: '/saved' }
  const store = new AgentModelCatalogStore()
  let active: AgentModelCatalogContext | undefined
  const home = (path: string) => ({ variable: 'CODEX_HOME', path })
  const makeContext = (path: string): AgentModelCatalogContext => {
    const context: AgentModelCatalogContext = {
      accountHome: home(path),
      fence: saved.lease.runtimeFence,
      acquisitionGeneration: path,
      isCurrent: () => active === context
    }
    return context
  }
  const probe = vi.fn(async (account: AgentSessionAccountHome) => ({
    ...listing('path' in account ? account.path : 'other'),
    complete: true
  }))
  const service = createAgentModelCatalogService({
    store,
    getRecord: () => saved,
    getConversation: () => agentSessionConversationView(saved),
    drivesRecord: () => true,
    resolveAccountHome: async () => home('/selected'),
    readCatalogContext: () => active,
    recordWorkspacePath: async () => '/repo',
    probes: { codex: probe }
  })
  try {
    await service.read({ agent: 'codex', sessionId: saved.sessionId, waitForListing: true })
    const idle = service.peek(saved.sessionId)
    expect(idle?.models[0]?.id).toBe('/saved')
    active = makeContext('/actual-1')
    const old = active
    expect(service.peek(saved.sessionId)).toBeNull()
    await service.read({ agent: 'codex', sessionId: saved.sessionId, waitForListing: true })
    expect(service.peek(saved.sessionId, true, old)?.models[0]?.id).toBe('/actual-1')
    const passive = await service.read({
      agent: 'codex',
      sessionId: saved.sessionId,
      savedOnly: true
    })
    expect(passive).toMatchObject({ models: [{ id: '/saved' }] })
    expect(service.peek(saved.sessionId, true, old)?.models[0]?.id).toBe('/actual-1')
    active = makeContext('/actual-2')
    expect(service.peek(saved.sessionId, false, old)).toBeNull()
    expect(await service.read({ agent: 'codex', sessionId: saved.sessionId }, old)).toEqual({
      origin: 'unknown'
    })
    await service.read({ agent: 'codex', sessionId: saved.sessionId, waitForListing: true })
    expect(service.peek(saved.sessionId, true, active)?.models[0]?.id).toBe('/actual-2')
    expect(
      await service.retainedLiveModelIds(saved.sessionId, {
        models: [{ id: '/actual-2', label: 'actual', isDefault: true, efforts: [] }]
      })
    ).toEqual(['/actual-2'])
    expect(probe).toHaveBeenCalledTimes(3)
    expect(saved.accountHome).toEqual(home('/saved'))
    active = { ...active, accountHome: null, isCurrent: () => true }
    expect(await service.read({ agent: 'codex', sessionId: saved.sessionId })).toEqual({
      origin: 'unknown'
    })
    expect(service.peek(saved.sessionId)).toBeNull()
    expect(probe).toHaveBeenCalledTimes(3)
    active = undefined
    const idleAgain = await service.read({
      agent: 'codex',
      sessionId: saved.sessionId,
      savedOnly: true
    })
    expect(idleAgain).toMatchObject({ models: [{ id: '/saved' }] })
  } finally {
    service.stop()
  }
})
