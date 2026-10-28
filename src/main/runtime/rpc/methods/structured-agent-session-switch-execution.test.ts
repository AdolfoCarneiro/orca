import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as cliTranscript from '../../../ai-vault/structured-chat-cli-fork'
import { structuredAgentRuntimeMetadata } from '../../structured-agent-runtime-metadata'
import { agentSessionProviderHandleChainHead } from '../../../../shared/agent-session-provider-handle'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createRestTestRig,
  restTestSend,
  type RestTestRig
} from '../../../native-chat/agent-session-wire/structured-agent-session-rest-test-rig'
import {
  createTestParams,
  CREATE_TEST_CALLER as caller
} from '../../../native-chat/agent-session-wire/structured-agent-session-create-test-fixture'
import { HOST_TEST_SESSION as id } from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  setupMainOwnedWorkspace,
  WORKTREE_ID,
  TAB_ID,
  LEAF_A,
  PTY_A,
  PTY_B,
  LEAF_B
} from '../../main-owned-workspace-runtime-fixture'
import { executeStructuredSessionSwitch } from './structured-agent-session-switch-execution'
import { SwitchToChatParams, SwitchToTerminalParams } from './structured-agent-session-schemas'
import { STRUCTURED_AGENT_SESSION_SWITCH_TO_CHAT_METHODS } from './structured-agent-session-switch-to-chat'
import type { RuntimeMobileSessionCreateTerminalResult } from '../../../../shared/runtime-types'
import { DaemonRequestTimeoutError } from '../../../daemon/daemon-errors'

let rig: RestTestRig
beforeEach(async () => {
  rig = await createRestTestRig({ idleSweep: { intervalMs: 60_000 } })
  const params = createTestParams()
  expect(
    await rig.host.create(
      caller,
      createTestParams(undefined, {
        location: { ...params.location, workspaceId: WORKTREE_ID }
      })
    )
  ).toMatchObject({ ok: true })
  setStructuredAgentSessionHost(rig.host)
})
afterEach(async () => {
  setStructuredAgentSessionHost(null)
  await rig.dispose()
  vi.restoreAllMocks()
})
const terminal: RuntimeMobileSessionCreateTerminalResult = {
  tab: {
    type: 'terminal',
    id: 'new:leaf',
    parentTabId: 'new',
    leafId: 'leaf',
    title: 'Codex',
    terminal: 'handle',
    status: 'ready',
    isActive: true
  },
  publicationEpoch: 'host',
  snapshotVersion: 1
}

it('executes empty/fresh through the ordinary terminal owner without requesting a saved resume or native identity', async () => {
  const { runtime } = setupMainOwnedWorkspace()
  const create = vi
    .spyOn(runtime, 'createSessionSwitchTerminal')
    .mockImplementation(async (_workspace, args) => {
      args.execution.check()
      expect(rig.adapter.closeSession).not.toHaveBeenCalled()
      return terminal
    })
  const result = await executeStructuredSessionSwitch(
    { sessionId: id, execution: { invocationId: 'fresh', commandOverride: 'cx' } },
    { runtime },
    'terminal'
  )
  expect(result).toMatchObject({ status: 'completed', terminal: terminal.tab.id })
  expect(create).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ sessionId: id, source: undefined, commandOverride: 'cx' })
  )
  expect(rig.adapter.acquire).not.toHaveBeenCalled()
})

it.each([false, true])(
  'publishes before slow startup and preserves a first send accepted during publication=%s',
  async (sendDuringPublication) => {
    const { runtime } = setupMainOwnedWorkspace()
    const acquired = Promise.withResolvers<void>()
    const original = rig.adapter.acquire.getMockImplementation()!
    rig.adapter.acquire.mockImplementation(async (...args) => {
      await acquired.promise
      return original(...args)
    })
    const publish = vi
      .spyOn(runtime, 'publishStructuredAgentSessionTab')
      .mockImplementation(async (input) => {
        input.check?.()
        await rig.store.setSessionTabVisibility(id, true)
        if (sendDuringPublication) {
          const sent = await rig.host.send(
            caller,
            restTestSend('A new explicit instruction', rig.store.getRecord(id)!.lease.runtimeFence)
          )
          expect(sent.ok).toBe(true)
        }
      })
    const result = await executeStructuredSessionSwitch(
      { sessionId: id, execution: { invocationId: 'slow-open' } },
      { runtime },
      'chat'
    )
    expect(result).toEqual({ status: 'completed', sessionId: id })
    expect(publish).toHaveBeenCalledOnce()
    expect(rig.store.getSessionTabId(id)).not.toBeNull()
    acquired.resolve()
    await vi.waitFor(() => expect(rig.adapter.acquire).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(rig.host.switchExecuting(id)).toBe(false))
    await vi.waitFor(() =>
      expect(rig.adapter.dispatch).toHaveBeenCalledTimes(sendDuringPublication ? 1 : 0)
    )
  }
)

async function savedTranscript() {
  await rig.host.switchToChat(id)
  await rig.host.switchToTerminal(id)
  const record = rig.store.getRecord(id)!
  const head = agentSessionProviderHandleChainHead(record.providerHandleChain)!
  const filePath = join(rig.root, 'switch-source.jsonl')
  const nativeId = head.handle.nativeId
  await writeFile(
    filePath,
    `${[
      { type: 'session_meta', payload: { id: nativeId } },
      {
        timestamp: '2026-10-26T12:00:00Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'cli-turn' }
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'A terminal prompt' }]
        }
      },
      {
        timestamp: '2026-10-26T12:00:01Z',
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 'cli-turn' }
      }
    ]
      .map((row) => JSON.stringify(row))
      .join('\n')}\n`
  )
  vi.spyOn(cliTranscript, 'resolveStructuredChatCliSource').mockResolvedValue({
    host: rig.host,
    record,
    head,
    agent: 'codex',
    cwd: rig.root,
    providerSessionId: nativeId,
    requireCurrent: vi.fn(),
    metadata: structuredAgentRuntimeMetadata('codex')!
  })
  vi.spyOn(cliTranscript, 'prepareStructuredChatCliTranscript').mockResolvedValue({
    useRealCodexHome: false,
    cliForkSource: {
      agent: 'codex',
      sourceAgent: 'codex',
      sessionId: nativeId,
      filePath,
      cwd: rig.root,
      codexHome: null,
      executionHostPlatform: process.platform
    }
  })
}

it.each(['single', 'split', 'split-during-stop'] as const)(
  'uses ordinary exact physical exit and source placement, retaining siblings: %s',
  async (shape) => {
    const split = shape !== 'single'
    await savedTranscript()
    const { runtime, session, bindPty } = setupMainOwnedWorkspace({ split: shape === 'split' })
    const incarnationId = '11111111-1111-4111-8111-111111111111'
    runtime.registerPty(PTY_A, WORKTREE_ID, null, { tabId: TAB_ID, leafId: LEAF_A, incarnationId })
    const source = runtime.resolveTerminalPane(`${TAB_ID}:${LEAF_A}`, WORKTREE_ID)
    if (!source.presentation) {
      throw new Error('missing captured source')
    }
    const exit = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const stopped = vi.fn(async (ptyId: string) => {
      expect(ptyId).toBe(PTY_A)
      entered.resolve()
      await exit.promise
      await runtime.onPtyExit(PTY_A, 0, incarnationId, { hostExitConfirmed: true })
      return true
    })
    runtime.setPtyController({
      write: () => true,
      kill: () => false,
      stopAndWait: stopped,
      getForegroundProcess: async () => 'codex'
    })
    expect(
      await runtime.applyLayoutCommand({
        type: 'openAgentSessionTab',
        workspace: WORKTREE_ID,
        sessionId: 'later-tab',
        agent: 'codex',
        tabId: 'agent-session:later-tab'
      })
    ).toMatchObject({ ok: true })
    const acquisitions = rig.adapter.acquire.mock.calls.length
    const operation = executeStructuredSessionSwitch(
      {
        sessionId: id,
        execution: {
          invocationId: 'from-pane',
          source: {
            terminal: source.handle,
            expectedIncarnationId: incarnationId,
            originalPresentation: source.presentation
          }
        }
      },
      { runtime },
      'chat'
    )
    await Promise.race([
      entered.promise,
      operation.then((answer) => {
        throw new Error(JSON.stringify(answer))
      })
    ])
    expect(rig.adapter.acquire).toHaveBeenCalledTimes(acquisitions)
    if (shape === 'split-during-stop') {
      expect(
        await runtime.applyLayoutCommand({
          type: 'splitPane',
          workspace: WORKTREE_ID,
          tabId: TAB_ID,
          leafId: LEAF_A,
          direction: 'vertical',
          newLeafId: LEAF_B
        })
      ).toMatchObject({ ok: true })
      bindPty({ worktreeId: WORKTREE_ID, tabId: TAB_ID, leafId: LEAF_B, ptyId: PTY_B })
      runtime.registerPty(PTY_B, WORKTREE_ID, null, { tabId: TAB_ID, leafId: LEAF_B })
    }
    exit.resolve()
    expect(await operation).toEqual({ status: 'completed', sessionId: id })
    await vi.waitFor(() => expect(rig.adapter.acquire).toHaveBeenCalledTimes(acquisitions + 1))
    expect(stopped).toHaveBeenCalledOnce()
    const destination = `agent-session:${id}`
    const group = session().tabGroups?.[WORKTREE_ID]?.find((row) =>
      row.tabOrder.includes(destination)
    )
    expect(group?.tabOrder).toEqual([
      ...(split ? [TAB_ID] : []),
      destination,
      'agent-session:later-tab'
    ])
    expect(group?.activeTabId).toBe(destination)
    expect((await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)).activeTabId).toBe(destination)
    const layout = session().terminalLayoutsByTabId[TAB_ID]
    if (split) {
      expect(layout?.ptyIdsByLeafId?.[LEAF_B]).toBe(PTY_B)
      expect(layout?.root).toEqual({ type: 'leaf', leafId: LEAF_B })
    } else {
      expect(session().tabsByWorktree[WORKTREE_ID]?.some((tab) => tab.id === TAB_ID)).toBe(false)
    }
    expect(rig.adapter.dispatch).not.toHaveBeenCalled()
  }
)

it('does not acquire or retire a terminal whose physical stop is unproven', async () => {
  await savedTranscript()
  const { runtime, session } = setupMainOwnedWorkspace()
  const incarnationId = '11111111-1111-4111-8111-111111111111'
  runtime.registerPty(PTY_A, WORKTREE_ID, null, { tabId: TAB_ID, leafId: LEAF_A, incarnationId })
  const source = runtime.resolveTerminalPane(`${TAB_ID}:${LEAF_A}`, WORKTREE_ID)
  if (!source.presentation) {
    throw new Error('missing captured source')
  }
  const acquisitions = rig.adapter.acquire.mock.calls.length
  const stop = vi.fn(async () => false)
  runtime.setPtyController({
    write: () => true,
    kill: () => false,
    stopAndWait: stop,
    getForegroundProcess: async () => null
  })
  const result = await executeStructuredSessionSwitch(
    {
      sessionId: id,
      execution: {
        invocationId: 'unproven',
        source: {
          terminal: source.handle,
          expectedIncarnationId: incarnationId,
          originalPresentation: source.presentation
        }
      }
    },
    { runtime },
    'chat'
  )
  expect(result.status).toBe('refused')
  expect(stop).toHaveBeenCalledOnce()
  expect(rig.adapter.acquire).toHaveBeenCalledTimes(acquisitions)
  expect(session().tabsByWorktree[WORKTREE_ID]?.some((tab) => tab.id === TAB_ID)).toBe(true)
})

it('reports a dispatched terminal with a lost answer as uncertain, preserving its source', async () => {
  const { runtime } = setupMainOwnedWorkspace()
  await rig.store.setSessionTabVisibility(id, false)
  await rig.store.setSessionTabVisibility(id, true, 'source-chat')
  vi.spyOn(runtime, 'createSessionSwitchTerminal').mockRejectedValue(
    new DaemonRequestTimeoutError('raw daemon text must not become start-failed copy')
  )
  const result = await executeStructuredSessionSwitch(
    { sessionId: id, execution: { invocationId: 'lost', sourceTabId: 'source-chat' } },
    { runtime },
    'terminal'
  )
  expect(result).toMatchObject({
    status: 'uncertain',
    refusal: { code: 'agent_session_operation_unknown', details: { reason: 'outcomeUnknown' } }
  })
  expect(rig.store.getSessionTabId(id)).toBe('source-chat')
})

it('retires the captured custom source and its ordinary projected row after fresh startup', async () => {
  const { runtime } = setupMainOwnedWorkspace()
  await rig.store.setSessionTabVisibility(id, false)
  await rig.store.setSessionTabVisibility(id, true, 'source-chat')
  await runtime.applyLayoutCommand({
    type: 'openAgentSessionTab',
    workspace: WORKTREE_ID,
    sessionId: id,
    agent: 'codex',
    tabId: 'source-chat'
  })
  runtime.projectStructuredAgentSessionTab({
    workspaceId: WORKTREE_ID,
    sessionId: id,
    agent: 'codex',
    activate: true
  })
  vi.spyOn(runtime, 'createSessionSwitchTerminal').mockResolvedValue(terminal)
  const result = await executeStructuredSessionSwitch(
    { sessionId: id, execution: { invocationId: 'retire', sourceTabId: 'source-chat' } },
    { runtime },
    'terminal'
  )
  expect(result).toMatchObject({ status: 'completed', sourceRetained: false })
  expect(rig.store.getSessionTabId(id)).toBeNull()
  expect(
    (await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)).tabs.some(
      (tab) => tab.type === 'agent-session' && tab.sessionId === id
    )
  ).toBe(false)
})

it('preserves the v1 request/result and start-only side effects when execution is absent', async () => {
  const { runtime } = setupMainOwnedWorkspace()
  expect(SwitchToChatParams.parse({ sessionId: id })).toEqual({ sessionId: id })
  expect(SwitchToTerminalParams.parse({ sessionId: id })).toEqual({ sessionId: id })
  expect(SwitchToChatParams.safeParse({ sessionId: id, other: true }).success).toBe(false)
  const publish = vi.spyOn(runtime, 'publishStructuredAgentSessionTab')
  const create = vi.spyOn(runtime, 'createSessionSwitchTerminal')
  const result = await STRUCTURED_AGENT_SESSION_SWITCH_TO_CHAT_METHODS[0].handler(
    { sessionId: id },
    { runtime }
  )
  expect(result).toEqual({ ok: true, sessionId: id })
  expect(publish).not.toHaveBeenCalled()
  expect(create).not.toHaveBeenCalled()
})

it('keeps strict v1 envelopes and journal effects for both a selected and already-starting failed child', async () => {
  const { runtime } = setupMainOwnedWorkspace()
  const opening = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  vi.spyOn(rig.host.deps.adapter, 'open').mockImplementation(async () => {
    entered.resolve()
    await opening.promise
    throw new Error('provider launch failed')
  })
  const method = STRUCTURED_AGENT_SESSION_SWITCH_TO_CHAT_METHODS[0]!
  const first = method.handler({ sessionId: id }, { runtime })
  await entered.promise
  const joined = method.handler({ sessionId: id }, { runtime })
  opening.resolve()
  const answer = await first
  expect(await joined).toEqual(answer)
  expect(Object.keys(answer).sort()).toEqual(['ok', 'refusal'])
  expect(answer).toEqual({
    ok: false,
    refusal: {
      code: 'agent_session_owner_restart_failed',
      message: "Codex couldn't start. Send your message to try again."
    }
  })
  const failures = (await rig.host.journalSnapshot(id)).items.filter(
    (item) => item.body.kind === 'status' && item.body.failure
  )
  expect(failures).toHaveLength(1)
})

it('publishes ordinary late startup failure once after the destination transcript is already visible', async () => {
  const { runtime } = setupMainOwnedWorkspace()
  const release = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  rig.adapter.acquire.mockImplementation(async () => {
    entered.resolve()
    await release.promise
    throw new Error('raw provider startup detail')
  })
  const result = await executeStructuredSessionSwitch(
    { sessionId: id, execution: { invocationId: 'late-failure' } },
    { runtime },
    'chat'
  )
  expect(result).toEqual({ status: 'completed', sessionId: id })
  await entered.promise
  expect(rig.store.getSessionTabId(id)).not.toBeNull()
  release.resolve()
  await vi.waitFor(async () => {
    const failures = (await rig.host.journalSnapshot(id)).items.filter(
      (item) => item.body.kind === 'status' && item.body.failure
    )
    expect(failures).toHaveLength(1)
    expect(JSON.stringify(failures)).not.toContain('raw provider startup detail')
  })
  expect(
    await executeStructuredSessionSwitch(
      { sessionId: id, execution: { invocationId: 'other-viewer' } },
      { runtime },
      'chat'
    )
  ).toEqual(result)
  expect(rig.adapter.acquire).toHaveBeenCalledOnce()
  expect(rig.adapter.dispatch).not.toHaveBeenCalled()
})

it.each([false, true])(
  'captures selection before native Stop and consumes it at the ordinary terminal snapshot: newer navigation=%s',
  async (navigate) => {
    const { runtime, bindPty, handleOf } = setupMainOwnedWorkspace()
    Object.assign(runtime, {
      resolveTerminalWorkspaceLaunchScope: async () => ({
        id: WORKTREE_ID,
        path: rig.root,
        connectionId: null,
        repo: null,
        folderWorkspace: null
      })
    })
    await runtime.publishStructuredAgentSessionTab({
      workspaceId: WORKTREE_ID,
      sessionId: id,
      agent: 'codex',
      activate: true,
      check: () => {}
    })
    await rig.host.switchToChat(id)
    const stopping = Promise.withResolvers<void>()
    const stopped = Promise.withResolvers<void>()
    rig.adapter.closeSession.mockImplementation(async () => {
      stopping.resolve()
      await stopped.promise
      return true
    })
    const spawn = vi
      .spyOn(runtime, 'createTerminal')
      .mockImplementation(async (_selector, opts = {}) => {
        opts.beforePtySpawn?.()
        opts.onPtySpawnDispatched?.({
          launchAgent: 'codex',
          ...(opts.launchConfig ? { launchConfig: opts.launchConfig } : {})
        })
        if (!opts.tabId || !opts.leafId) {
          throw new Error('missing ordinary published pane')
        }
        bindPty({
          worktreeId: WORKTREE_ID,
          tabId: opts.tabId,
          leafId: opts.leafId,
          ptyId: 'switch-destination'
        })
        runtime.registerPty('switch-destination', WORKTREE_ID, null, {
          tabId: opts.tabId,
          leafId: opts.leafId,
          terminalHandle: opts.preAllocatedHandle
        })
        return {
          handle: handleOf('switch-destination'),
          ptyId: 'switch-destination',
          tabId: opts.tabId,
          paneKey: `${opts.tabId}:${opts.leafId}`,
          worktreeId: WORKTREE_ID,
          title: null,
          surface: 'background'
        }
      })
    const operation = executeStructuredSessionSwitch(
      {
        sessionId: id,
        execution: { invocationId: 'ordinary-native-stop', sourceTabId: `agent-session:${id}` }
      },
      { runtime },
      'terminal'
    )
    await Promise.race([
      stopping.promise,
      operation.then((answer) => {
        throw new Error(JSON.stringify(answer))
      })
    ])
    expect(spawn).not.toHaveBeenCalled()
    if (navigate) {
      runtime.projectStructuredAgentSessionTab({
        workspaceId: WORKTREE_ID,
        sessionId: 'newer-navigation',
        agent: 'codex',
        activate: true
      })
    }
    stopped.resolve()
    const answer = await operation
    expect(answer).toMatchObject({ status: 'completed' })
    expect(spawn).toHaveBeenCalledOnce()
    const snapshot = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
    expect(snapshot.activeTabId).toBe(
      navigate
        ? 'agent-session:newer-navigation'
        : `${spawn.mock.calls[0]![1]!.tabId}::${spawn.mock.calls[0]![1]!.leafId}`
    )
  }
)
