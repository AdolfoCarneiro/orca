import { writeFile, rm, mkdir } from 'node:fs/promises'
import type * as NativeFs from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createRestTestRig,
  restTestSend,
  type RestTestRig
} from './structured-agent-session-rest-test-rig'
import {
  createTestParams,
  stopCreatedChat,
  CREATE_TEST_CALLER as CALLER
} from './structured-agent-session-create-test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestOperationId,
  hostTestMessage
} from './structured-agent-session-host-test-data'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'

const candidateIO = vi.hoisted(() => ({ denied: '' }))
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof NativeFs>()
  return {
    ...actual,
    realpath: (...args: Parameters<typeof actual.realpath>) => {
      if (candidateIO.denied && String(args[0]).startsWith(candidateIO.denied)) {
        throw Object.assign(new Error('unrelated candidate denied'), { code: 'EACCES' })
      }
      return actual.realpath(...args)
    }
  }
})

let rig: RestTestRig
beforeEach(async () => {
  rig = await createRestTestRig({ idleSweep: { intervalMs: 60_000 } })
})
afterEach(async () => {
  await rig.dispose()
  candidateIO.denied = ''
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

async function adoptedParams(history = 'adopted history', threadId = THREAD) {
  const transcriptPath = join(rig.root, 'rollout.jsonl')
  await writeFile(
    transcriptPath,
    [
      JSON.stringify({
        type: 'session_meta',
        payload: { id: threadId, timestamp: '2026-09-06T18:00:00.000Z', cwd: rig.root }
      }),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-09-06T18:00:01.000Z',
        payload: { type: 'message', role: 'user', content: history }
      })
    ].join('\n')
  )
  return createTestParams(undefined, {
    adopt: { providerHandle: codexProviderHandle(threadId), transcriptPath }
  })
}

function anotherSession(params: AgentSessionAttachParams): AgentSessionAttachParams {
  return createTestParams(undefined, {
    ...params,
    envelope: {
      ...params.envelope,
      sessionId: 'session-second',
      clientOperationId: hostTestOperationId()
    }
  })
}

it('imports adoption at rest and resumes its original provider identity after its source disappears', async () => {
  const params = await adoptedParams()
  expect(await rig.host.create(CALLER, params)).toMatchObject({
    ok: true,
    value: {
      page: {
        items: expect.arrayContaining([
          expect.objectContaining({
            body: expect.objectContaining({ blocks: [{ type: 'text', text: 'adopted history' }] })
          })
        ])
      }
    }
  })
  expect(rig.store.getRecord(SESSION)?.providerHandleChain).toMatchObject([
    { origin: 'adopted', mintedAtFence: 1, handle: { nativeId: THREAD } }
  ])
  expect(rig.adapter.acquire).not.toHaveBeenCalled()
  await rm(join(rig.root, 'rollout.jsonl'))
  expect(
    await rig.host.create(CALLER, {
      ...params,
      accountHome: { variable: 'CODEX_HOME', path: '/drifted/account' },
      adopt: { providerHandle: codexProviderHandle(THREAD) }
    })
  ).toMatchObject({ ok: true, replayed: true })
  expect(await rig.host.send(CALLER, restTestSend('new work'))).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledOnce())
  expect(rig.adapter.acquire).toHaveBeenCalledWith(
    expect.objectContaining({
      identity: expect.objectContaining({
        providerHandle: expect.objectContaining({ nativeId: THREAD })
      })
    })
  )
  expect(rig.store.getRecord(SESSION)?.accountHome).toEqual(params.accountHome)
})

it('refuses concurrent adoption of a provider conversation by another session', async () => {
  const params = await adoptedParams()
  const results = await Promise.all([
    rig.host.create(CALLER, params),
    rig.host.create(CALLER, anotherSession(params))
  ])
  expect(results.filter((result) => result.ok)).toHaveLength(1)
  expect(results.filter((result) => !result.ok)).toMatchObject([
    {
      refusal: {
        code: 'agent_session_conflict',
        details: {
          reason: 'conversationHeldElsewhere',
          owner: { sessionId: expect.any(String), workspaceId: params.location.workspaceId }
        },
        createAttemptRefusedBeforeCommit: true
      }
    }
  ])
  expect(rig.store.listRecords()).toHaveLength(1)
  expect(rig.store.listOperationRows()).toHaveLength(1)
  expect(rig.adapter.acquire).not.toHaveBeenCalled()
})

it('the real store transaction rejects a UUID case-variant writer across distinct account homes', async () => {
  const params = await adoptedParams()
  const second = anotherSession(params)
  second.accountHome = { variable: 'CODEX_HOME', path: join(rig.root, 'different-store') }
  second.adopt = { ...params.adopt!, providerHandle: codexProviderHandle(THREAD.toUpperCase()) }
  const results = await Promise.all([
    rig.host.create(CALLER, params),
    rig.host.create(CALLER, second)
  ])
  expect(results.filter((result) => result.ok)).toHaveLength(1)
  expect(results.find((result) => !result.ok)).toMatchObject({
    refusal: { code: 'agent_session_conflict' }
  })
  expect(rig.store.listRecords()).toHaveLength(1)
  expect(rig.adapter.acquire).not.toHaveBeenCalled()
  const { requireUnownedStructuredAgentSessionAdoption } =
    await import('../../runtime/structured-agent-session-create-adoption')
  const owner = rig.store.listRecords()[0]!
  expect(() =>
    requireUnownedStructuredAgentSessionAdoption({
      host: rig.host,
      agent: 'codex',
      providerSessionId: THREAD.toUpperCase(),
      selfSessionId: 'new-writer'
    })
  ).toThrow()
  expect(() =>
    requireUnownedStructuredAgentSessionAdoption({
      host: rig.host,
      agent: 'codex',
      providerSessionId: THREAD.toUpperCase(),
      selfSessionId: owner.sessionId
    })
  ).not.toThrow()
  expect(() =>
    requireUnownedStructuredAgentSessionAdoption({
      host: rig.host,
      agent: 'codex',
      providerSessionId: '019fd532-7c11-7a90-b6de-4e1a2c3d5f61',
      selfSessionId: 'new-writer'
    })
  ).not.toThrow()
})

it('refuses concurrent founding under a tab another chat already owns', async () => {
  const params = createTestParams(undefined, { surfaceTabId: 'reserved-chat-tab' })
  const results = await Promise.all([
    rig.host.create(CALLER, params),
    rig.host.create(CALLER, anotherSession(params))
  ])
  expect(results.filter((result) => result.ok)).toHaveLength(1)
  expect(results.filter((result) => !result.ok)).toMatchObject([
    { refusal: { code: 'agent_session_conflict', details: { reason: 'tabIdTaken' } } }
  ])
  expect(rig.store.listVisibleSessionIds()).toHaveLength(1)
  expect(rig.adapter.acquire).not.toHaveBeenCalled()
})

it.each(['missing', 'empty', 'malformed'] as const)(
  'refuses %s history before founding anything',
  async (source) => {
    const params = await adoptedParams()
    await (source === 'missing'
      ? rm(join(rig.root, 'rollout.jsonl'))
      : writeFile(join(rig.root, 'rollout.jsonl'), source === 'empty' ? '' : '{broken json}\n'))
    expect(await rig.host.create(CALLER, params)).toMatchObject({
      ok: false,
      refusal: {
        code: 'agent_session_identity_required',
        details: { reason: source === 'empty' ? 'transcriptNotFound' : 'transcriptUnreadable' },
        createAttemptRefusedBeforeCommit: true
      }
    })
    expect(rig.store.listRecords()).toEqual([])
    expect(rig.store.listOperationRows()).toEqual([])
  }
)

it('does not found a record whose account namespace its agent cannot drive', async () => {
  const params = createTestParams(undefined, {
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/wrong/account' }
  })
  expect(await rig.host.create(CALLER, params)).toMatchObject({
    ok: false,
    refusal: { code: 'structured_agent_session_unsupported' }
  })
  expect(rig.store.listRecords()).toEqual([])
  expect(rig.store.listOperationRows()).toEqual([])
})

it.each([
  { executionHostId: 'local', wslDistro: null },
  { executionHostId: 'ssh:host-1', wslDistro: null },
  { executionHostId: 'local', wslDistro: 'Ubuntu' },
  { executionHostId: 'runtime:paired-host', wslDistro: null }
] as const)(
  'preserves folder execution identity at rest: $executionHostId $wslDistro',
  async (location) => {
    const params = createTestParams(undefined, {
      location: { ...location, workspaceId: 'folder-1', workspaceKind: 'folder' }
    })
    expect(await rig.host.create(CALLER, params)).toMatchObject({ ok: true })
    expect(rig.store.getRecord(SESSION)?.location).toEqual(params.location)
    expect(rig.adapter.acquire).not.toHaveBeenCalled()
  }
)

it('pins the host-resolved directory of a floating chat before any acquire', async () => {
  const params = createTestParams(undefined, {
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: FLOATING_TERMINAL_WORKTREE_ID,
      workspaceKind: 'folder'
    }
  })
  expect(await rig.host.create(CALLER, params, { hostLaunchDirectory: rig.root })).toMatchObject({
    ok: true
  })
  expect(rig.store.getRecord(SESSION)?.launchDirectory).toBe(rig.root)
  expect(rig.adapter.acquire).not.toHaveBeenCalled()
})

it.each(['adopted', 'blank'] as const)(
  'retries a rolled-back create with only the new %s history',
  async (nextSource) => {
    const first = { clientMessageId: hostTestOperationId(), body: hostTestMessage('first attempt') }
    const adopted = await adoptedParams('old imported history')
    const db = openTestJournalHostDatabase(rig.root).db
    db.exec(
      `CREATE TRIGGER refuse_first BEFORE INSERT ON journal_rows WHEN NEW.row_json LIKE '%"kind":"submission"%' BEGIN SELECT RAISE(ABORT, 'simulated first write failure'); END`
    )
    expect(
      await rig.host.create(CALLER, createTestParams(first, adopted), { firstMessage: first })
    ).toMatchObject({ ok: false })
    expect(rig.store.getRecord(SESSION)).toBeNull()
    expect(rig.store.listOperationRows()).toEqual([])
    db.exec('DROP TRIGGER refuse_first')
    const next = { clientMessageId: hostTestOperationId(), body: hostTestMessage('next attempt') }
    const nextParams =
      nextSource === 'adopted'
        ? await adoptedParams('new imported history', '019fd532-7c11-7a90-b6de-4e1a2c3d5f61')
        : createTestParams()
    let stopping: ReturnType<typeof stopCreatedChat> | undefined
    const result = await rig.host.create(
      CALLER,
      createTestParams(next, {
        ...nextParams,
        envelope: { ...nextParams.envelope, clientOperationId: hostTestOperationId() }
      }),
      {
        firstMessage: next,
        publishTab: async () => {
          stopping = stopCreatedChat(rig.host)
        }
      }
    )
    expect(result).toMatchObject({ ok: true })
    if (!result.ok) {
      throw new Error('retry create failed')
    }
    const history = (text: string) =>
      expect.objectContaining({
        body: expect.objectContaining({ blocks: [{ type: 'text', text }] })
      })
    expect(result.value.page.items).not.toEqual(
      expect.arrayContaining([history('old imported history')])
    )
    if (nextSource === 'adopted') {
      expect(result.value.page.items).toEqual(
        expect.arrayContaining([history('new imported history')])
      )
    }
    expect(await stopping).toMatchObject({ ok: true })
    expect(rig.adapter.acquire).not.toHaveBeenCalled()
  }
)

it('healthy recognized adoption reaches real create, reservation and send settlement despite unrelated candidate IO', async () => {
  vi.stubEnv('ORCA_USER_DATA_PATH', rig.root)
  const { CODEX_CLI_CONVERSATIONS } = await import('../../codex/codex-cli-conversations')
  const { resolveStructuredAgentSessionAdoptionForCreate } =
    await import('../../runtime/structured-agent-session-create-adoption')
  const { resolveCodexLaunchHome } = await import('../../codex/codex-launch-home')
  const X = join(rig.root, 'original-X'),
    H = join(rig.root, 'system-H')
  const broken = join(rig.root, 'accounts', 'broken', 'overlays', 'a'.repeat(32))
  await mkdir(join(X, 'sessions'), { recursive: true })
  await mkdir(H)
  await mkdir(broken, { recursive: true })
  const params = await adoptedParams()
  const transcript = join(X, 'sessions', 'rollout.jsonl')
  await writeFile(
    transcript,
    await (await import('node:fs/promises')).readFile(join(rig.root, 'rollout.jsonl'))
  )
  candidateIO.denied = broken
  const operation = {}
  const adoption = await resolveStructuredAgentSessionAdoptionForCreate({
    settings: { codexManagedAccounts: [{ managedHomePath: broken }, { managedHomePath: X }] },
    agent: 'codex',
    transcriptImport: CODEX_CLI_CONVERSATIONS.transcriptImport!,
    providerSessionId: THREAD,
    selectedAccountHome: { variable: 'CODEX_HOME', path: broken },
    launchEnv: {},
    workspaceCwd: rig.root,
    resolveTranscriptPath: () => transcript,
    prepareCodexResume: async () => ({
      substituteCodexHome: resolveCodexLaunchHome({
        selectedAccount: null,
        systemHome: H,
        storeHome: X,
        accountsRoot: join(rig.root, 'actors'),
        operation
      })
    })
  })
  expect(adoption.accountHome).toMatchObject({ variable: 'CODEX_HOME' })
  const result = await rig.host.create(CALLER, {
    ...params,
    accountHome: adoption.accountHome,
    adopt: { ...params.adopt!, transcriptPath: adoption.transcriptPath }
  })
  expect(result).toMatchObject({ ok: true })
  expect(rig.store.getRecord(SESSION)?.accountHome).toEqual(adoption.accountHome)
  expect(
    await rig.host.send(CALLER, restTestSend('continue recognized conversation'))
  ).toMatchObject({ ok: true })
  await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledOnce())
  expect(rig.adapter.acquire).toHaveBeenCalledOnce()
})
