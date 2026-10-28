import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as cliTranscript from '../../../ai-vault/structured-chat-cli-fork'
import * as processTable from '../../../../shared/process-table-snapshot-reader'
import {
  assertCliConversationWritersExited,
  posixCliWriterShellAlone
} from '../../structured-agent-cli-writers'
import { structuredAgentRuntimeMetadata } from '../../structured-agent-runtime-metadata'
import { agentSessionProviderHandleChainHead } from '../../../../shared/agent-session-provider-handle'
import { captureTerminalSurfaceIdentity } from '../../../../shared/terminal-tab-close'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createRestTestRig,
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
  LEAF_A
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

it('returns readable chat before selected provider readiness without starting it twice', async () => {
  const { runtime } = setupMainOwnedWorkspace()
  const acquired = Promise.withResolvers<void>()
  const original = rig.adapter.acquire.getMockImplementation()!
  rig.adapter.acquire.mockImplementation(async (...args) => {
    await acquired.promise
    return original(...args)
  })
  vi.spyOn(runtime, 'publishStructuredAgentSessionTab').mockImplementation(async (input) => {
    input.check?.()
    await rig.store.setSessionTabVisibility(id, true)
  })
  const close = vi.spyOn(runtime, 'closeSwitchedSourceTerminal')
  const params = { sessionId: id, execution: { invocationId: 'chat' } }
  const view = await executeStructuredSessionSwitch(params, { runtime }, 'chat')
  expect(view.status).toBe('present')
  expect(rig.adapter.acquire).not.toHaveBeenCalled()
  if (view.status !== 'present') {
    throw new Error('missing shown handshake')
  }
  const opened = await executeStructuredSessionSwitch(
    {
      ...params,
      execution: {
        ...params.execution,
        receipt: { generation: view.generation, shown: true }
      }
    },
    { runtime },
    'chat'
  )
  expect(opened).toMatchObject({ status: 'completed', startupPending: true })
  const completion = executeStructuredSessionSwitch(
    {
      ...params,
      execution: {
        ...params.execution,
        observe: true
      }
    },
    { runtime },
    'chat'
  )
  acquired.resolve()
  expect(await completion).toMatchObject({ status: 'completed', sourceRetained: false })
  expect(rig.adapter.acquire).toHaveBeenCalledOnce()
  expect(close).not.toHaveBeenCalled()
})

it('keeps opened chat visible and returns the exact committed selected start failure separately', async () => {
  const { runtime } = setupMainOwnedWorkspace()
  vi.spyOn(runtime, 'publishStructuredAgentSessionTab').mockImplementation(async () => {
    await rig.store.setSessionTabVisibility(id, true)
  })
  vi.spyOn(rig.host.deps.adapter, 'open').mockRejectedValue(new Error('provider launch failed'))
  const params = { sessionId: id, execution: { invocationId: 'failed' } }
  const view = await executeStructuredSessionSwitch(params, { runtime }, 'chat')
  if (view.status !== 'present') {
    throw new Error('missing shown handshake')
  }
  await executeStructuredSessionSwitch(
    {
      ...params,
      execution: {
        ...params.execution,
        receipt: { generation: view.generation, shown: true }
      }
    },
    { runtime },
    'chat'
  )
  const result = await executeStructuredSessionSwitch(
    {
      ...params,
      execution: {
        ...params.execution,
        observe: true
      }
    },
    { runtime },
    'chat'
  )
  expect(result).toMatchObject({ status: 'refused', failureItemId: expect.any(String) })
  if (result.status !== 'refused') {
    throw new Error('missing selected failure')
  }
  const failures = (await rig.host.journalSnapshot(id)).items.filter(
    (item) => item.body.kind === 'status' && item.body.failure
  )
  expect(failures).toHaveLength(1)
  expect(failures[0].itemId).toBe(result.failureItemId)
  expect(
    await executeStructuredSessionSwitch(
      { ...params, execution: { ...params.execution, observe: true } },
      { runtime },
      'chat'
    )
  ).toEqual(result)
  expect(rig.store.getRecord(id)).not.toBeNull()
  expect(rig.store.getSessionTabId(id)).not.toBeNull()
})

it.each(['children', 'unknown'] as const)(
  'retains the source with a factual typed refusal when inspection reports %s',
  async (evidence) => {
    const { runtime, session } = setupMainOwnedWorkspace()
    const identity = captureTerminalSurfaceIdentity(session(), WORKTREE_ID, TAB_ID, LEAF_A)
    if (!identity) {
      throw new Error('Expected the workspace fixture terminal surface')
    }
    vi.spyOn(runtime, 'inspectTerminalProcess').mockResolvedValue(
      evidence === 'children'
        ? { foregroundProcess: 'codex', hasChildProcesses: true, childProcessEvidence: 'children' }
        : {
            foregroundProcess: null,
            hasChildProcesses: false,
            verdict: 'unverifiable',
            reason: 'timeout'
          }
    )
    const close = vi.spyOn(runtime, 'closeSwitchedSourceTerminal')
    const result = await executeStructuredSessionSwitch(
      {
        sessionId: id,
        execution: {
          invocationId: 'inspection',
          source: {
            terminal: 'source',
            expectedIncarnationId: 'source-incarnation',
            originalPresentation: { identity, holders: [{ hostId: 'local', identity }] }
          }
        }
      },
      { runtime },
      'chat'
    )
    expect(result).toMatchObject({
      status: evidence === 'children' ? 'refused' : 'uncertain',
      refusal: {
        code:
          evidence === 'children'
            ? 'agent_session_operation_invalid'
            : 'agent_session_operation_unknown',
        details: {
          reason: evidence === 'children' ? 'conversationOpenInTerminal' : 'outcomeUnknown'
        }
      }
    })
    expect(rig.adapter.acquire).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
  }
)

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

it.each([false, true])('keeps chat with cleanup=%s', async (cleanupCompletes) => {
  await rig.host.switchToChat(id)
  await rig.host.switchToTerminal(id)
  const record = rig.store.getRecord(id)!
  const head = agentSessionProviderHandleChainHead(record.providerHandleChain)!
  const filePath = join(rig.root, 'cleanup-source.jsonl')
  const nativeId = head.handle.nativeId
  let shellExited = false
  const phases: string[] = []
  const acquisition = Promise.withResolvers<void>()
  vi.spyOn(processTable, 'getFreshShellForegroundSnapshot').mockImplementation(async () => {
    phases.push(shellExited ? 'census-exited' : 'census-live')
    return shellExited ? [] : [{ pid: 101, ppid: 1, stat: 'S+', command: '-/bin/zsh -l' }]
  })
  const writer = vi.fn(async () => {
    await acquisition.promise
    await assertCliConversationWritersExited(
      {
        rows: () => [
          {
            paneKey: 'source',
            worktreeId: WORKTREE_ID,
            connectionId: null,
            agentType: 'codex',
            receivedAt: 1,
            stateStartedAt: 1,
            state: 'done',
            prompt: '',
            providerSession: { key: 'session_id', id: nativeId }
          }
        ],
        saved: () => [],
        observation: () => ({
          current: () => true,
          topology: 'pane-owned',
          presence: async () => 'exited'
        }),
        terminal: () => ({
          pane: {
            ptyId: 'source',
            incarnationId: 'source-incarnation',
            identity: 'source:original'
          }
        }),
        links: () => [],
        sleeping: () => false,
        shellAlone: () => posixCliWriterShellAlone(101)
      },
      'codex',
      nativeId
    )
  })
  rig.host.deps.assertNoTerminalWriter = writer
  await writeFile(
    filePath,
    `${[
      { type: 'session_meta', payload: { id: nativeId } },
      {
        timestamp: '2026-10-26T12:00:00Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'terminal-turn' }
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Finish the change' }]
        }
      },
      {
        timestamp: '2026-10-26T12:00:01Z',
        type: 'event_msg',
        payload: { type: 'task_complete', turn_id: 'terminal-turn' }
      }
    ]
      .map((row) => JSON.stringify(row))
      .join('\n')}\n`
  )
  // External source lookup/preparation is the I/O boundary; journal catch-up and host/start ownership stay real.
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
  const { runtime } = setupMainOwnedWorkspace()
  vi.spyOn(runtime, 'inspectTerminalProcess').mockResolvedValue({
    foregroundProcess: 'zsh',
    hasChildProcesses: false,
    childProcessEvidence: 'no-children',
    switchWitness: 'before-probe'
  })
  vi.spyOn(runtime, 'publishStructuredAgentSessionTab').mockImplementation(async (input) => {
    input.check?.()
    await rig.store.setSessionTabVisibility(id, true)
  })
  const cleanup = vi.spyOn(runtime, 'closeSwitchedSourceTerminal').mockImplementation(async () => {
    if (cleanupCompletes) {
      shellExited = true
      phases.push('shell-exit')
    }
    return cleanupCompletes
  })
  const params = {
    sessionId: id,
    execution: {
      invocationId: 'cleanup-refused',
      source: {
        terminal: 'term_source',
        expectedIncarnationId: '11111111-1111-4111-8111-111111111111'
      }
    }
  }
  const view = await executeStructuredSessionSwitch(params, { runtime }, 'chat')
  if (view.status !== 'present') {
    throw new Error('missing shown handshake')
  }
  const opened = await executeStructuredSessionSwitch(
    {
      ...params,
      execution: { ...params.execution, receipt: { generation: view.generation, shown: true } }
    },
    { runtime },
    'chat'
  )
  expect(opened).toMatchObject({ status: 'completed', startupPending: true })
  acquisition.resolve()
  const result = await executeStructuredSessionSwitch(
    { ...params, execution: { ...params.execution, observe: true } },
    { runtime },
    'chat'
  )
  expect.soft(phases).toEqual(['census-live', ...(cleanupCompletes ? ['shell-exit'] : [])])
  await expect.soft(writer.mock.results[0]?.value).resolves.toBeUndefined()
  expect(result).toMatchObject({ status: 'completed', sourceRetained: !cleanupCompletes })
  expect(cleanup).toHaveBeenCalledOnce()
  expect(rig.store.getSessionTabId(id)).not.toBeNull()
})

it('does not invent a failed journal item when acquisition fails before a selected child exists', async () => {
  const { runtime } = setupMainOwnedWorkspace()
  vi.spyOn(runtime, 'publishStructuredAgentSessionTab').mockImplementation(async () => {
    await rig.store.setSessionTabVisibility(id, true)
  })
  rig.adapter.acquire.mockRejectedValue(new Error('acquire refused'))
  const params = { sessionId: id, execution: { invocationId: 'pre-child-failure' } }
  const view = await executeStructuredSessionSwitch(params, { runtime }, 'chat')
  if (view.status !== 'present') {
    throw new Error('missing shown handshake')
  }
  await executeStructuredSessionSwitch(
    {
      ...params,
      execution: { ...params.execution, receipt: { generation: view.generation, shown: true } }
    },
    { runtime },
    'chat'
  )
  const result = await executeStructuredSessionSwitch(
    { ...params, execution: { ...params.execution, observe: true } },
    { runtime },
    'chat'
  )
  expect(result).toMatchObject({ status: 'refused' })
  expect(result).not.toHaveProperty('failureItemId')
  expect(
    (await rig.host.journalSnapshot(id)).items.filter(
      (item) => item.body.kind === 'status' && item.body.failure
    )
  ).toEqual([])
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
