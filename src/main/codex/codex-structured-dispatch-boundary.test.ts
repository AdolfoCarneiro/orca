import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
  readFileSync,
  unlinkSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { safeRemoveTree } from '../pty/overlay-mirror'
import { resolveCodexLaunchHome } from './codex-launch-home'
import { createCodexStructuredLaunchResolver } from '../runtime/structured-agent-launch-composition.test-support'
import { CodexStructuredSessionAdapter } from './codex-structured-session-adapter'
import { CODEX_STRUCTURED_AGENT } from './codex-structured-agent-definition'
import { codexTurnLifecycleFake } from './codex-turn-lifecycle-fake'
import { agentSessionRecordFixture } from '../native-chat/agent-session-record-test-fixture'
import { agentSessionConversationView } from '../../shared/agent-session-conversation-view'
import { agentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import { modelCatalogHostDeps } from '../runtime/structured-agent-model-catalog-wiring'
import { STRUCTURED_AGENT_RUNTIME_REGISTRATIONS } from '../runtime/structured-agent-runtime-registrations'
import { createStructuredAgentEnvironmentResolvers } from '../runtime/structured-agent-shell-environment'
import type { StructuredAgentSessionRuntimeDeps } from '../runtime/structured-agent-session-runtime'
import type { AgentModelCatalogService } from '../native-chat/agent-model-catalog/agent-model-catalog-service'
import { StructuredAgentRegistry } from '../native-chat/agent-session-wire/structured-agent-registry'
import { StructuredAgentSessionAdapterRouter } from '../native-chat/agent-session-wire/structured-agent-session-adapter-router'
import { StructuredAgentSessionInputNotAdmitted } from '../native-chat/agent-session-wire/structured-agent-session-input-admission'
import { expect, it, vi } from 'vitest'
import { AgentSessionPreDispatchError } from '../native-chat/agent-session-wire/structured-agent-session-operation-settlement'
import {
  type LateSettlement,
  acquiredCodexAdapter,
  CODEX_TEST_USER_MESSAGE,
  startTurn,
  echoUserMessage,
  refuseUnroutedSteer,
  fakeCodexAppServer,
  recordingSink
} from './codex-structured-dispatch-test-support'

it('checks continuation authority before writing turn/start', async () => {
  const codex = fakeCodexAppServer()
  const adapter = await acquiredCodexAdapter({ codex, settlements: [] })
  const beforeDispatch = vi.fn(async () => {
    throw new AgentSessionPreDispatchError('agent_session_restart_work_superseded')
  })
  try {
    await expect(
      adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId: 'continuation',
        body: CODEX_TEST_USER_MESSAGE,
        fence: 7,
        beforeDispatch
      })
    ).rejects.toBeInstanceOf(AgentSessionPreDispatchError)
    expect(beforeDispatch).toHaveBeenCalledOnce()
    expect(codex.connections[0]?.calls.some((call) => call.method === 'turn/start')).toBe(false)
  } finally {
    await adapter.closeAll()
  }
})

it('stops a refused steer before its fallback write', async () => {
  const refused = Promise.withResolvers<unknown>()
  const codex = fakeCodexAppServer({ 'turn/steer': () => refused.promise })
  const settlements: LateSettlement[] = []
  const adapter = await acquiredCodexAdapter({ codex, settlements })
  const connection = codex.connections[0]!
  startTurn(connection, 'running')
  const controller = new AbortController()
  const reason = new Error('Stopped before fallback')
  const send = (id: string) =>
    adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: id,
      fence: 7,
      body: CODEX_TEST_USER_MESSAGE,
      signal: controller.signal
    })
  const sending = send('stopped')
  await vi.waitFor(() =>
    expect(connection.calls.some((call) => call.method === 'turn/steer')).toBe(true)
  )
  controller.abort(reason)
  try {
    refuseUnroutedSteer(undefined)
  } catch (error) {
    refused.reject(error)
  }
  await expect(sending).rejects.toBeInstanceOf(StructuredAgentSessionInputNotAdmitted)
  await expect(sending).rejects.toMatchObject({
    outcome: {
      state: 'rejected',
      rejection: { kind: 'cancelled' },
      reason: 'provider_cancelled_before_start'
    }
  })
  expect(connection.calls.some((call) => call.method === 'turn/start')).toBe(false)
  // The journal keeps stopped sends rejected even if an exact echo arrives.
  echoUserMessage(connection, { turnId: 'running', itemId: 'stopped', clientId: 'stopped' })
  expect(settlements.map((entry) => entry.clientMessageId)).toEqual(['stopped'])
  await adapter.closeAll()
})

it('abandons only the stopped message while waiting for a previous turn to open', async () => {
  const codex = fakeCodexAppServer({ 'turn/start': () => ({ turn: { id: 'opening' } }) })
  const settlements: LateSettlement[] = []
  const adapter = await acquiredCodexAdapter({ codex, settlements })
  const connection = codex.connections[0]!
  const dispatch = (id: string, signal?: AbortSignal) =>
    adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: id,
      fence: 7,
      body: CODEX_TEST_USER_MESSAGE,
      signal
    })
  await expect(dispatch('first')).resolves.toMatchObject({ state: 'admitted' })
  const controller = new AbortController()
  const stopped = dispatch('waiting', controller.signal)
  await new Promise<void>((resolve) => setTimeout(resolve, 10))
  const reason = new Error('Stopped local wait')
  controller.abort(reason)
  await expect(stopped).rejects.toBeInstanceOf(StructuredAgentSessionInputNotAdmitted)
  await expect(stopped).rejects.toMatchObject({
    outcome: {
      state: 'rejected',
      rejection: { kind: 'cancelled' },
      reason: 'provider_cancelled_before_start'
    }
  })
  expect(connection.calls.filter((call) => call.method === 'turn/start')).toHaveLength(1)
  startTurn(connection, 'opening')
  echoUserMessage(connection, { turnId: 'opening', itemId: 'first', clientId: 'first' })
  expect(settlements.map((entry) => entry.clientMessageId)).toEqual(['first'])
  await adapter.closeAll()
})

it.each(['accepted', 'uncertain'] as const)(
  'retains the %s outcome of a steer written before Stop',
  async (outcome) => {
    const answer = Promise.withResolvers<unknown>()
    const codex = fakeCodexAppServer({ 'turn/steer': () => answer.promise })
    const settlements: LateSettlement[] = []
    const adapter = await acquiredCodexAdapter({ codex, settlements })
    const connection = codex.connections[0]!
    startTurn(connection, 'running')
    const controller = new AbortController()
    const sent = adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'written',
      fence: 7,
      body: CODEX_TEST_USER_MESSAGE,
      signal: controller.signal
    })
    await vi.waitFor(() =>
      expect(connection.calls.some((call) => call.method === 'turn/steer')).toBe(true)
    )
    controller.abort(new Error('Stop after write'))
    if (outcome === 'accepted') {
      answer.resolve({ turnId: 'running' })
      await expect(sent).resolves.toMatchObject({ state: 'admitted' })
    } else {
      const lost = new Error('Reply lost after write')
      answer.reject(lost)
      await expect(sent).rejects.toBe(lost)
    }
    echoUserMessage(connection, { turnId: 'running', itemId: 'written', clientId: 'written' })
    expect(settlements.map((entry) => entry.clientMessageId)).toEqual(['written'])
    await adapter.closeAll()
  }
)

it('uses the actual fresh acquisition for native catalog defaults through dispatch and completion', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'codex-catalog-owner-')))
  const system = join(root, 'system')
  const login = join(root, 'codex-accounts', 'a', 'home')
  mkdirSync(system)
  mkdirSync(login, { recursive: true })
  writeFileSync(join(login, '.orca-managed-home'), 'a')
  writeFileSync(join(login, 'auth.json'), '{"fixture":"a"}')
  const savedHome = resolveCodexLaunchHome({
    selectedAccount: { homePath: login },
    conversationHome: system,
    systemHome: system
  })!
  // Native detach is legitimate: a new acquisition must not borrow this saved actor's default.
  unlinkSync(join(savedHome, 'auth.json'))
  writeFileSync(join(savedHome, 'auth.json'), '{"fixture":"detached"}')
  const savedBytes = readFileSync(join(savedHome, 'auth.json'), 'utf8')
  const record = agentSessionRecordFixture({
    sessionId: 'session-1',
    provider: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: savedHome },
    options: { model: 'gpt-prior', effort: 'high' }
  })
  record.lease.runtimeFence = 7
  const codex = fakeCodexAppServer()
  const turns = codexTurnLifecycleFake(
    'thread-abc',
    () => (method, params) => codex.connections[0]?.handlers.onNotification?.(method, params)
  )
  Object.assign(codex.routes, turns.routes)
  const store = agentModelCatalogStore
  const probeHomes: string[] = []
  const runtimeDeps: StructuredAgentSessionRuntimeDeps = {
    stateDirectory: root,
    hostId: 'local',
    claimKeyId: 'fixture',
    resolveWorkspacePath: async () => root,
    resolveLaunchArgs: () => [],
    resolveClaudeAuthPolicy: () => ({ account: 'system' }),
    resolveEnvironment: async () => ({ HOME: root, PATH: '/bin' }),
    resolveAgentAccountHome: async () => ({ variable: 'CODEX_HOME', path: login }),
    resolveCodexCommand: () => 'codex',
    logger: { warn: vi.fn(), error: vi.fn() },
    runCodexCatalogSession: async (invocation, body) => {
      const home = invocation.env?.CODEX_HOME ?? ''
      probeHomes.push(home)
      return body({
        notify: () => {},
        request: async (method) => {
          if (method === 'model/list') {
            return {
              data: [
                {
                  model: 'gpt-actual',
                  displayName: 'Actual',
                  isDefault: home !== savedHome,
                  defaultReasoningEffort: 'medium',
                  supportedReasoningEfforts: [
                    { reasoningEffort: 'medium' },
                    { reasoningEffort: 'high' }
                  ]
                }
              ],
              nextCursor: null
            }
          }
          if (method === 'config/read') {
            return {
              config:
                home === savedHome ? {} : { model: 'gpt-actual', model_reasoning_effort: 'medium' }
            }
          }
          return {} // Missing account readback is not a new refusal.
        }
      })
    }
  }
  const resolveLaunch = createCodexStructuredLaunchResolver({
    store: { getRecord: () => record, pinLaunchDirectory: async () => record },
    resolveWorkspacePath: async () => root,
    resolveEnvironment: async () => ({ HOME: root, PATH: '/bin' }),
    resolveLaunchArgs: () => [],
    resolveCommand: () => 'codex',
    prepareLaunchHome: ({ conversationHome, operation }) =>
      resolveCodexLaunchHome({
        selectedAccount: { homePath: login },
        conversationHome,
        operation,
        systemHome: system
      }) ?? null
  })
  let service: AgentModelCatalogService
  const settlements: LateSettlement[] = []
  const adapter = new CodexStructuredSessionAdapter({
    resolveLaunch,
    openConnection: codex.openConnection,
    readProcessStartTime: async () => 100,
    modelCatalog: store,
    readModelCatalog: (id, verified, context) => service.peek(id, verified, context),
    demandModelCatalog: (id, legacy, context) =>
      service.read(
        {
          agent: 'codex',
          sessionId: id,
          waitForListing: true,
          ...(legacy ? { legacy: true } : {})
        },
        context
      ),
    onDispatchSettledLate: (result) => settlements.push(result)
  })
  const registry = new StructuredAgentRegistry([{ definition: CODEX_STRUCTURED_AGENT, adapter }])
  const router = new StructuredAgentSessionAdapterRouter(registry, () => adapter.closeAll())
  const hostCatalog = await modelCatalogHostDeps({
    store: {
      getRecord: () => record,
      getConversation: () => agentSessionConversationView(record),
      listConversations: () => [agentSessionConversationView(record)]
    },
    agents: registry,
    registrations: STRUCTURED_AGENT_RUNTIME_REGISTRATIONS.filter(
      ({ definition }) => definition.agent === 'codex'
    ),
    deps: runtimeDeps,
    environment: createStructuredAgentEnvironmentResolvers(runtimeDeps)
  })
  service = hostCatalog.modelCatalog!
  const identity = {
    sessionId: record.sessionId,
    workspaceId: record.location.workspaceId,
    hostId: 'local',
    agent: 'codex',
    providerHandle: null
  }
  try {
    const acquired = await router.acquire({
      identity,
      fence: 7,
      spawnToken: 'test-catalog-spawn',
      events: recordingSink(),
      options: record.options
    })
    const context = router.readCatalogContext('session-1')!
    expect(context.isCurrent()).toBe(true) // Actual connection exists, before thread/session publication.
    const actual = codex.connections[0]!.launch.env?.CODEX_HOME
    expect(context.accountHome).toEqual({ variable: 'CODEX_HOME', path: actual })
    expect(actual).not.toBe(savedHome)
    const result = await service.read({
      agent: 'codex',
      sessionId: 'session-1',
      waitForListing: true
    })
    expect(result).toMatchObject({
      models: [expect.objectContaining({ id: 'gpt-actual', isDefault: true })]
    })
    expect(probeHomes).toEqual([actual])
    service.providerStarted(record)
    expect(service.peek('session-1', true, context)?.models[0]?.id).toBe('gpt-actual')
    await router.open({
      sessionId: 'session-1',
      fence: 7,
      acquisitionGeneration: acquired.acquisitionGeneration,
      signal: new AbortController().signal
    })
    expect(router.readCatalogContext('session-1')).toBe(context)
    expect(context.isCurrent()).toBe(true) // Registered attempt is now removed.
    await expect(
      router.dispatch({
        sessionId: 'session-1',
        fence: 7,
        clientMessageId: 'actual-default',
        body: CODEX_TEST_USER_MESSAGE,
        executionOptions: {}
      })
    ).resolves.toMatchObject({ state: 'admitted' })
    const turn = codex.connections[0]!.calls.find((call) => call.method === 'turn/start')
    expect(turn?.params).toMatchObject({ model: 'gpt-actual', effort: 'medium' })
    turns.start()
    turns.echo('actual-default')
    turns.end('completed')
    expect(settlements).toEqual([
      expect.objectContaining({
        clientMessageId: 'actual-default',
        providerIdentity: expect.objectContaining({ turnId: expect.any(String) })
      })
    ])
    expect(readFileSync(join(savedHome, 'auth.json'), 'utf8')).toBe(savedBytes)
    // Explicit saved reads never probe, replace the live key or repair O0.
    await service.read({ agent: 'codex', sessionId: 'session-1', savedOnly: true })
    expect(probeHomes).toEqual([actual])
    expect(service.peek('session-1', true, context)).not.toBeNull()
    await adapter.closeAll()
    expect(context.isCurrent()).toBe(false)
    expect(service.peek('session-1', true, context)).toBeNull()
  } finally {
    service.stop()
    await adapter.closeAll()
    await store.flushPersistence()
    safeRemoveTree(root)
  }
})
