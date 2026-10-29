import { randomUUID } from 'node:crypto'
import type * as ProcessHost from '@orca/process-host'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createStructuredAgentSessionId,
  structuredAgentSessionCreateParams
} from '../../../../shared/structured-agent-session-create'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import {
  createRestTestRig,
  type RestTestRig
} from '../../../native-chat/agent-session-wire/structured-agent-session-rest-test-rig'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { HOST_TEST_THREAD } from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import {
  setupMainOwnedWorkspace,
  WORKTREE_ID,
  TAB_ID,
  LEAF_A,
  PTY_A
} from '../../main-owned-workspace-runtime-fixture'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status-types'
import * as writerProcess from '../../structured-agent-cli-writers'
import { executeStructuredSessionSwitch } from './structured-agent-session-switch-execution'
import { SwitchToChatParams } from './structured-agent-session-schemas'
import {
  switchConversationIdentity,
  switchRetainedOwner
} from './structured-agent-session-switch-source'
import { createTestParams } from '../../../native-chat/agent-session-wire/structured-agent-session-create-test-fixture'
import { PI_RPC_AGENT } from '../../../pi/rpc-agent-definition'
import { StructuredAgentRegistry } from '../../../native-chat/agent-session-wire/structured-agent-registry'

vi.mock('../../structured-agent-shell-environment', () => ({
  resolveHostAgentBaseEnvironment: async () => ({}),
  refreshHostAgentBaseEnvironmentAfterMiss: async () => {}
}))
vi.mock('../../../agent-workspace-trust', () => ({ applyAgentWorkspaceTrust: async () => ({}) }))
vi.mock('@orca/process-host', async (importOriginal) => ({
  ...(await importOriginal<typeof ProcessHost>()),
  runProcess: async () => ({
    stdout: 'codex 0.200.0',
    stderr: '',
    code: 0,
    timedOut: false,
    outputTruncated: false
  })
}))

let rig: RestTestRig
beforeEach(async () => {
  rig = await createRestTestRig({
    idleSweep: { intervalMs: 60_000 },
    resolveWorkspacePath: async () => rig.root,
    resolveLaunchEnv: async () => ({ CODEX_HOME: rig.root })
  })
  vi.stubEnv('HOME', join(rig.root, 'home'))
  vi.stubEnv('USERPROFILE', join(rig.root, 'home'))
  vi.stubEnv('ORCA_USER_DATA_PATH', join(rig.root, 'user-data'))
  vi.stubEnv('CODEX_HOME', rig.root)
  vi.spyOn(Date, 'now').mockImplementation(() => rig.clock.now)
  const acquire = rig.adapter.acquire.getMockImplementation()!
  rig.adapter.acquire.mockImplementation(async (input) => {
    const acquired = await acquire(input)
    return {
      ...acquired,
      ...(acquired.link ? { link: { ...acquired.link, origin: 'resumed' as const } } : {})
    }
  })
  setStructuredAgentSessionHost(rig.host)
})
afterEach(async () => {
  setStructuredAgentSessionHost(null)
  await rig.dispose()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

it.each([
  { retained: false, working: false, navigation: 'none', otherAccount: false },
  { retained: false, working: true, navigation: 'preparation', otherAccount: false },
  { retained: true, working: false, navigation: 'stop', otherAccount: false },
  { retained: false, working: false, navigation: 'none', otherAccount: true }
] as const)(
  'composes generated viewer envelopes through actual create admission and exact Stop: %j',
  async ({ retained, working, navigation, otherAccount }) => {
    const filePath = join(
      rig.root,
      'sessions',
      `rollout-2026-10-28T00-00-00-${HOST_TEST_THREAD}.jsonl`
    )
    await mkdir(join(rig.root, 'sessions'), { recursive: true })
    const transcript = `${[
      { type: 'session_meta', payload: { id: HOST_TEST_THREAD, cwd: rig.root } },
      {
        timestamp: '2026-10-28T00:00:00Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'cli-turn' }
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'A saved prompt' }]
        }
      },
      ...(working
        ? []
        : [
            {
              timestamp: '2026-10-28T00:00:01Z',
              type: 'event_msg',
              payload: { type: 'task_complete', turn_id: 'cli-turn' }
            }
          ])
    ]
      .map((row) => JSON.stringify(row))
      .join('\n')}\n`
    await writeFile(filePath, transcript)
    const preparing = Promise.withResolvers<void>()
    const prepared = Promise.withResolvers<void>()
    let holdPreparation = false
    let selectedHome = rig.root
    const prepareHome = vi.fn(async () => {
      if (holdPreparation && navigation === 'preparation') {
        preparing.resolve()
        await prepared.promise
      }
      return selectedHome
    })
    let exited = false
    const launchHome = vi.fn(async () => rig.root)
    const { runtime, session, handleOf } = setupMainOwnedWorkspace({
      runtimeDeps: {
        resolveCodexStructuredLaunchHome: prepareHome,
        prepareCodexStructuredLaunch: launchHome,
        readHookCliWriterObservation: () => ({
          current: () => true,
          topology: 'pane-owned',
          presence: async () => (exited ? 'exited' : 'live')
        })
      }
    })
    // Only workspace filesystem lookup and external process/account I/O are supplied by the fixture.
    vi.spyOn(runtime, 'resolveRuntimeFileTarget').mockResolvedValue({
      executionHostId: 'local',
      worktree: {
        id: WORKTREE_ID,
        repoId: 'repo-1',
        parentWorktreeId: null,
        childWorktreeIds: [],
        lineage: null,
        path: rig.root,
        displayName: 'workspace',
        comment: '',
        linkedIssue: null,
        linkedPR: null,
        linkedLinearIssue: null,
        isArchived: false,
        isUnread: false,
        isPinned: false,
        sortOrder: 0,
        lastActivityAt: 0,
        branch: 'main',
        head: 'head',
        isBare: false,
        isMainWorktree: true,
        git: { path: rig.root, head: 'head', branch: 'main', isBare: false, isMainWorktree: true }
      }
    })
    vi.spyOn(runtime, 'prepareAiVaultSessionResume').mockResolvedValue({ useRealCodexHome: false })
    vi.spyOn(writerProcess, 'posixCliWriterShellAlone').mockResolvedValue(false)
    const incarnationId = '11111111-1111-4111-8111-111111111111'
    runtime.registerPty(PTY_A, WORKTREE_ID, null, { tabId: TAB_ID, leafId: LEAF_A, incarnationId })
    const row: AgentStatusIpcPayload = {
      paneKey: `${TAB_ID}:${LEAF_A}`,
      worktreeId: WORKTREE_ID,
      connectionId: null,
      agentType: 'codex',
      state: working ? 'working' : 'waiting',
      prompt: '',
      receivedAt: 1,
      stateStartedAt: 1,
      providerSession: { key: 'session_id', id: HOST_TEST_THREAD, transcriptPath: filePath }
    }
    vi.spyOn(runtime, 'getAgentProviderSessionRows').mockImplementation(() => (exited ? [] : [row]))
    vi.spyOn(runtime.agentTransitions, 'latestRow').mockImplementation(() => (exited ? null : row))
    const stopEntered = Promise.withResolvers<void>()
    const exit = Promise.withResolvers<void>()
    const stop = vi.fn(async () => {
      stopEntered.resolve()
      await exit.promise
      exited = true
      await runtime.onPtyExit(PTY_A, 0, incarnationId, { hostExitConfirmed: true })
      return true
    })
    runtime.setPtyController({
      write: () => true,
      kill: () => false,
      stopAndWait: stop,
      getForegroundProcess: async () => 'codex',
      listProcesses: async () =>
        exited
          ? []
          : [
              {
                id: PTY_A,
                cwd: rig.root,
                title: 'Codex',
                worktreeId: WORKTREE_ID,
                terminalHandle: handleOf(PTY_A),
                rootProcessId: 10,
                incarnationId
              }
            ]
    })
    const source = runtime.resolveTerminalPane(row.paneKey, WORKTREE_ID)
    if (!source.presentation) {
      throw new Error('missing source presentation')
    }
    const resumeFrom = {
      providerSessionId: HOST_TEST_THREAD,
      cliSource: { workspaceId: WORKTREE_ID, paneKey: row.paneKey }
    }
    const createIntent = () => {
      const sessionId = createStructuredAgentSessionId('codex', randomUUID)
      return {
        sessionId,
        params: structuredAgentSessionCreateParams({
          sessionId,
          worktree: `id:${WORKTREE_ID}`,
          agent: 'codex',
          resumeFrom,
          randomUuid: randomUUID
        })
      }
    }
    const first = createIntent()
    const second = createIntent()
    expect(first.sessionId).not.toBe(second.sessionId)
    let canonical = first.sessionId
    if (otherAccount) {
      const otherHome = join(rig.root, 'other-account')
      await mkdir(join(otherHome, 'sessions'), { recursive: true })
      await writeFile(join(otherHome, 'sessions', basename(filePath)), transcript)
      selectedHome = otherHome
      const attach = await runtime.resolveStructuredAgentSessionCreateIdentity({
        ...first.params,
        resumeFrom: { providerSessionId: HOST_TEST_THREAD }
      })
      selectedHome = rig.root
      expect(attach.accountHome).toEqual({ variable: 'CODEX_HOME', path: otherHome })
      expect(
        await rig.host.create(
          { callerKey: 'setup' },
          createTestParams(undefined, {
            ...attach,
            envelope: { ...attach.envelope, sessionId: 'other-account-native' }
          })
        )
      ).toMatchObject({ ok: true })
    }
    if (retained) {
      const attach = await runtime.resolveStructuredAgentSessionCreateIdentity(first.params)
      const created = await rig.host.create(
        { callerKey: 'setup' },
        createTestParams(undefined, {
          ...attach,
          envelope: { ...attach.envelope, sessionId: first.sessionId }
        })
      )
      expect(created).toMatchObject({ ok: true })
      await rig.host.switchToChat(first.sessionId)
      await rig.host.switchToTerminal(first.sessionId)
      canonical = first.sessionId
    }
    const generated = (intent: typeof first, invocationId: string) =>
      SwitchToChatParams.parse({
        sessionId: intent.sessionId,
        execution: {
          invocationId,
          create: intent.params,
          source: {
            terminal: source.handle,
            expectedIncarnationId: incarnationId,
            originalPresentation: source.presentation
          }
        }
      })
    // Retained return still carries a fresh generated ID, never the known native owner.
    const a = retained ? second : first
    const b = createIntent()
    await expect(runtime.resolveStructuredAgentSessionCreateIntent(a.params)).rejects.toMatchObject(
      {
        refusal: {
          code: 'agent_session_conflict',
          details: { reason: 'conversationHeldElsewhere' }
        }
      }
    )
    const commands = vi.spyOn(rig.host, 'runSwitch')
    const acquisitions = rig.adapter.acquire.mock.calls.length
    const launchPreparations = launchHome.mock.calls.length
    holdPreparation = true
    const operation = executeStructuredSessionSwitch(generated(a, 'viewer-a'), { runtime }, 'chat')
    const navigate = () =>
      runtime.projectStructuredAgentSessionTab({
        workspaceId: WORKTREE_ID,
        sessionId: 'newer-navigation',
        agent: 'codex',
        activate: true
      })
    if (navigation === 'preparation') {
      await preparing.promise
      navigate()
      prepared.resolve()
    }
    await Promise.race([
      stopEntered.promise,
      operation.then((answer) => {
        throw new Error(JSON.stringify(answer))
      })
    ])
    const duplicate = executeStructuredSessionSwitch(generated(b, 'viewer-b'), { runtime }, 'chat')
    expect(rig.adapter.acquire).toHaveBeenCalledTimes(acquisitions)
    expect(rig.store.getRecord(a.sessionId)).toBeNull()
    expect(launchHome).toHaveBeenCalledTimes(launchPreparations)
    await vi.waitFor(() => expect(commands).toHaveBeenCalledTimes(2))
    if (navigation === 'stop') {
      navigate()
    }
    exit.resolve()
    const answer = await operation
    expect(answer).toEqual({ status: 'completed', sessionId: canonical })
    expect(await duplicate).toEqual(answer)
    if (working) {
      expect(
        (await rig.host.journalSnapshot(canonical)).items
          .filter((item) => item.body.kind === 'turn')
          .map((item) => item.body)
      ).toContainEqual(expect.objectContaining({ state: 'interrupted' }))
    }
    expect(stop).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(rig.adapter.acquire).toHaveBeenCalledTimes(acquisitions + 1))
    await vi.waitFor(() => expect(rig.store.getRecord(canonical)?.lease.claimStatus).toBe('live'))
    expect(rig.adapter.dispatch).not.toHaveBeenCalled()
    const snapshot = await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)
    expect(snapshot.activeTabId).toBe(
      `agent-session:${navigation === 'none' ? canonical : 'newer-navigation'}`
    )
    expect(session().unifiedTabs?.[WORKTREE_ID]?.some((tab) => tab.entityId === canonical)).toBe(
      true
    )
  }
)

it('uses registered Pi History IDs and isolates account and owning host for prefounding/native command identity', async () => {
  const filePath = join(rig.root, `2026-10-28T00-00-00_${HOST_TEST_THREAD}.jsonl`)
  const transcript = `${[
    { type: 'session', version: 3, id: HOST_TEST_THREAD },
    {
      type: 'message',
      id: 'pi-user',
      parentId: null,
      message: { role: 'user', content: 'Saved Pi prompt' }
    },
    {
      type: 'message',
      id: 'pi-reply',
      parentId: 'pi-user',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Saved reply' }],
        stopReason: 'stop'
      }
    }
  ]
    .map((row) => JSON.stringify(row))
    .join('\n')}\n`
  await writeFile(filePath, transcript)
  const identity = {
    provider: 'pi' as const,
    accountHome: { variable: 'PI_CODING_AGENT_DIR', path: rig.root },
    location: {
      executionHostId: 'local' as const,
      wslDistro: null,
      workspaceId: WORKTREE_ID,
      workspaceKind: 'git-worktree' as const
    }
  }
  const piRig = await createRestTestRig({
    agents: new StructuredAgentRegistry([
      {
        definition: PI_RPC_AGENT,
        adapter: {
          ...rig.host.deps.adapter,
          compact: async () => {
            throw new Error('identity-only fixture never contacts the provider')
          }
        }
      }
    ])
  })
  try {
    const created = await piRig.host.create(
      { callerKey: 'setup' },
      createTestParams(undefined, {
        ...identity,
        agent: 'pi',
        adopt: {
          providerHandle: { transport: 'jsonl-rpc', agent: 'pi', nativeId: filePath },
          transcriptPath: filePath
        }
      })
    )
    // Use the actual ordinary import/founding owner, with a valid registered transcript.
    expect(created).toMatchObject({ ok: true })
    expect(switchRetainedOwner(piRig.host, identity, HOST_TEST_THREAD)).toBe(
      created.ok ? created.value.sessionId : null
    )
    const key = switchConversationIdentity(identity, HOST_TEST_THREAD).commandKey
    expect(switchConversationIdentity(identity, filePath).commandKey).toBe(key)
    for (const [index, scoped] of [
      {
        ...identity,
        accountHome: { ...identity.accountHome, path: join(rig.root, 'other-account') }
      },
      {
        ...identity,
        location: { ...identity.location, executionHostId: toRuntimeExecutionHostId('other') }
      },
      { ...identity, location: { ...identity.location, wslDistro: 'Ubuntu' } }
    ].entries()) {
      expect(switchRetainedOwner(piRig.host, scoped, HOST_TEST_THREAD)).toBeNull()
      await mkdir(scoped.accountHome.path, { recursive: true })
      const scopedPath = join(scoped.accountHome.path, basename(filePath))
      await writeFile(scopedPath, transcript)
      const params = createTestParams(undefined, {
        ...scoped,
        agent: 'pi',
        envelope: { ...createTestParams().envelope, sessionId: `pi-scoped-${index}` },
        adopt: {
          providerHandle: { transport: 'jsonl-rpc', agent: 'pi', nativeId: scopedPath },
          transcriptPath: scopedPath
        }
      })
      expect(await piRig.host.create({ callerKey: 'setup' }, params)).toMatchObject({ ok: true })
      expect(switchRetainedOwner(piRig.host, scoped, HOST_TEST_THREAD)).toBe(
        params.envelope.sessionId
      )
      expect(switchConversationIdentity(scoped, HOST_TEST_THREAD).commandKey).not.toBe(key)
    }
    const aliasPath = join(rig.root, 'same-account-copy', `copy_${HOST_TEST_THREAD}.jsonl`)
    await mkdir(join(rig.root, 'same-account-copy'))
    await writeFile(aliasPath, transcript)
    const duplicate = createTestParams(undefined, {
      ...identity,
      agent: 'pi',
      envelope: { ...createTestParams().envelope, sessionId: 'pi-duplicate' },
      adopt: {
        providerHandle: { transport: 'jsonl-rpc', agent: 'pi', nativeId: aliasPath },
        transcriptPath: aliasPath
      }
    })
    expect(await piRig.host.create({ callerKey: 'setup' }, duplicate)).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_conflict', details: { reason: 'conversationHeldElsewhere' } }
    })
    expect(piRig.store.listRecords()).toHaveLength(4)
  } finally {
    await piRig.dispose()
  }
})
