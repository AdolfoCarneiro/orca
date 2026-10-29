import './unused-default-rpc-methods.test-fixture'
import { createHash } from 'node:crypto'
import {
  OrcaRuntimeService,
  type OrchestrationCompatibilityTerminalAuthority
} from '../orca-runtime'
import { ORCHESTRATION_SEND_METHODS } from './methods/orchestration/messaging/send-methods'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation
} from '../structured-worker-identity'
import {
  ADDRESS_X,
  ADDRESS_Y,
  createSessionCallerHarness,
  idOf,
  isRecord,
  orchestrationRequest,
  resultOf,
  PROVIDER_ID_X,
  SESSION_X,
  SESSION_Y,
  sessionRecord,
  WORKER_HANDLE,
  WORKER_PANE,
  type SessionCallerHarness
} from './orchestration-session-caller-test-fixture'

const hostRef = vi.hoisted((): { current: unknown } => ({ current: null }))
vi.mock('../../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

import { attachRemoteDispatch } from './methods/orchestration/federation/federated-message-targeting.test-fixture'

type Row = Record<string, unknown>

describe.each([false, true])('a send addressed to an agent session, attached=%s', (attached) => {
  let h: SessionCallerHarness
  let visible: string[]

  beforeEach(() => {
    h = createSessionCallerHarness(hostRef, () => ({ present: true, sessionIds: visible }))
    visible = [SESSION_X, SESSION_Y]
    if (attached) {
      attachRemoteDispatch(h.db, h.runtime, 'run-home', {
        paneKey: WORKER_PANE,
        terminalHandle: WORKER_HANDLE
      })
    }
  })

  afterEach(() => {
    h.close()
    vi.restoreAllMocks()
  })

  async function send(to: string): Promise<Row> {
    const response: unknown = await h.dispatch(
      orchestrationRequest('orchestration.send', { from: 'term_worker', to, subject: 'hello' })
    )
    if (!isRecord(response)) {
      throw new Error('expected an RPC response object')
    }
    return response
  }

  function errorMessage(response: Row): string {
    return isRecord(response.error) ? String(response.error.message) : ''
  }

  it('stores mail to a live session that coordinates nothing at its own address, and points it', async () => {
    // Public session ids remain routable even without live panes or durable Run/Dispatch mailboxes.
    const deliver = vi.spyOn(h.runtime, 'deliverPendingMessagesForHandle')
    const sent = await send(ADDRESS_X)
    expect(sent).toMatchObject({ ok: true, result: { message: { to_handle: ADDRESS_X } } })
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledWith(ADDRESS_X, expect.anything()))
  })

  it('accepts a bare Orca session id and normalizes it', async () => {
    expect(await send(SESSION_X)).toMatchObject({
      ok: true,
      result: { message: { to_handle: ADDRESS_X } }
    })
  })

  it('keeps routing a coordinating session to its Run mailbox', async () => {
    const created = await h.dispatch(
      orchestrationRequest('orchestration.runCreate', { objective: 'o' }, { sessionId: SESSION_X })
    )
    const runId = idOf(resultOf(created).run)
    expect(await send(ADDRESS_X)).toMatchObject({
      ok: true,
      result: { message: { to_handle: `run:${runId}` } }
    })
  })

  it('keeps canonical, bare and committed clear-successor recipient spellings on the same mailbox', async () => {
    h.records.set(SESSION_X, {
      ...sessionRecord(SESSION_X),
      conversationCommand: {
        command: 'clear',
        state: 'completed',
        replacementSessionId: SESSION_Y,
        operationId: 'clear-op',
        callerKey: 'caller',
        phase: 'committed'
      }
    })
    visible = [SESSION_Y]
    for (const to of [ADDRESS_X, ADDRESS_Y, SESSION_Y]) {
      expect(await send(to)).toMatchObject({
        ok: true,
        result: { message: { to_handle: ADDRESS_X } }
      })
    }
    expect(h.db.getInbox()).toHaveLength(3)
  })

  it.each([
    [
      'an unknown session',
      () => `orca_session_id:0b0b0b0b-1111-4222-8333-444444444444`,
      'session_caller_unknown'
    ],
    ['a malformed session address', () => 'orca_session_id:term_abc', 'session_caller_unknown'],
    ['a provider id', () => `orca_session_id:${PROVIDER_ID_X}`, 'session_caller_provider_id'],
    ['a bare provider id', () => PROVIDER_ID_X, 'session_caller_provider_id']
  ])('refuses %s before storing anything', async (_label, to, code) => {
    const sent = await send(to())
    expect(sent).toMatchObject({ ok: false, error: { code } })
    expect(h.db.getInbox(100)).toEqual([])
  })

  it.each([
    ['a provider id', () => `orca_session_id:${PROVIDER_ID_X}`],
    ['a bare provider id', () => PROVIDER_ID_X]
  ])('hands back the Orca session address to paste instead of %s', async (_label, to) => {
    expect(errorMessage(await send(to()))).toBe(
      `${PROVIDER_ID_X} is the provider's own session id, which changes on /clear. This session's Orca session ID is orca_session_id:${SESSION_X}; address it by that instead. No message was sent.`
    )
  })

  it('refuses the retired session:<id> spelling like any unknown terminal handle', async () => {
    expect(await send(`session:${SESSION_X}`)).toMatchObject({
      ok: false,
      error: {
        code: 'terminal_not_found',
        message: `Terminal session:${SESSION_X} has no live pane or durable Run/Dispatch mailbox.`
      }
    })
    expect(h.db.getInbox(100)).toEqual([])
  })

  it('refuses a session on another host', async () => {
    h.records.set(SESSION_Y, sessionRecord(SESSION_Y, { location: { executionHostId: 'ssh:box' } }))
    expect(await send(`orca_session_id:${SESSION_Y}`)).toMatchObject({
      ok: false,
      error: { code: 'session_caller_host_boundary' }
    })
    expect(h.db.getInbox(100)).toEqual([])
  })

  it('refuses a session whose chat was closed, naming why', async () => {
    visible = [SESSION_X]
    const sent = await send(`orca_session_id:${SESSION_Y}`)
    expect(sent).toMatchObject({ ok: false, error: { code: 'session_caller_not_live' } })
    expect(errorMessage(sent)).toContain('its chat was closed')
    expect(h.db.getInbox(100)).toEqual([])
  })

  it('refuses a structured worker whose worker identity is gone: nothing could ever read it', async () => {
    // A Dispatch recorded the session as a worker; no registry entry or custody row maps it now.
    const run = h.db.createRun({
      objective: 'pty',
      coordinatorHandle: 'term_c',
      coordinatorPaneKey: 'tab_c:13131313-1313-4313-8313-131313131313'
    })
    h.db.createDispatchContext({
      taskId: h.db.createTask({ runId: run.id, spec: 'work' }).id,
      assigneeHandle: mintStructuredWorkerHandle(),
      assigneePaneKey: mintStructuredWorkerPaneKey(SESSION_Y),
      processIncarnation: structuredWorkerProcessIncarnation(SESSION_Y),
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER
    })
    structuredWorkerIdentities.clear()
    const sent = await send(`orca_session_id:${SESSION_Y}`)
    expect(sent).toMatchObject({ ok: false, error: { code: 'session_caller_not_live' } })
    expect(errorMessage(sent)).toContain('worker identity')
  })

  it('leaves a bare string that is no session a terminal handle, as before', async () => {
    expect(await send('0b0b0b0b-1111-4222-8333-444444444444')).toMatchObject({
      ok: false,
      error: { code: 'terminal_not_found' }
    })
  })
})

describe('a live structured worker addressed by its session id', () => {
  let h: SessionCallerHarness
  const handle = mintStructuredWorkerHandle()
  const paneKey = mintStructuredWorkerPaneKey(SESSION_Y)

  beforeEach(() => {
    h = createSessionCallerHarness(hostRef)
    structuredWorkerIdentities.register({
      handle,
      sessionId: SESSION_Y,
      agent: 'claude',
      paneKey,
      processIncarnation: structuredWorkerProcessIncarnation(SESSION_Y),
      worktreeId: 'wt_1',
      hostScope: { kind: 'local', hostId: 'local' }
    })
  })

  afterEach(() => {
    h.close()
    vi.restoreAllMocks()
  })

  async function sendTo(to: string): Promise<Row> {
    return resultOf(
      await h.dispatch(
        orchestrationRequest('orchestration.send', { from: 'term_worker', to, subject: 'hello' })
      )
    )
  }

  async function flaglessCheck(): Promise<Row> {
    return resultOf(
      await h.dispatch(
        orchestrationRequest('orchestration.check', { peek: true }, { sessionId: SESSION_Y })
      )
    )
  }

  it('lands in its Dispatch mailbox, which its flagless check reads', async () => {
    // Mail formerly landed at the session address while worker check read handle/Dispatch mailboxes and found nothing.
    const run = h.db.createRun({
      objective: 'pty coordinator',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:12121212-1212-4212-8212-121212121212'
    })
    const dispatch = h.db.createDispatchContext({
      taskId: h.db.createTask({ runId: run.id, spec: 'work' }).id,
      assigneeHandle: handle,
      assigneePaneKey: paneKey,
      processIncarnation: structuredWorkerProcessIncarnation(SESSION_Y),
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER
    })
    expect(await sendTo(`orca_session_id:${SESSION_Y}`)).toMatchObject({
      message: { to_handle: `dispatch:${dispatch.id}` }
    })
    expect(await flaglessCheck()).toMatchObject({ messages: [{ subject: 'hello' }] })
  })

  it('lands in its own handle mailbox between Dispatches, which its flagless check reads', async () => {
    expect(await sendTo(SESSION_Y)).toMatchObject({ message: { to_handle: handle } })
    expect(await flaglessCheck()).toMatchObject({ messages: [{ subject: 'hello' }] })
  })
})

describe('mail sent to a session address reaches the mailbox that session reads', () => {
  let h: SessionCallerHarness

  beforeEach(() => {
    h = createSessionCallerHarness(hostRef)
  })

  afterEach(() => {
    h.close()
    vi.restoreAllMocks()
  })

  async function as(sessionId: string | undefined, method: string, params: Row): Promise<Row> {
    return resultOf(await h.dispatch(orchestrationRequest(method, params, { sessionId })))
  }

  function sendFromTerminal(to: string): Promise<Row> {
    return as(undefined, 'orchestration.send', { from: WORKER_HANDLE, to, subject: 'hello' })
  }

  it("files it under the chat's current Run, as a terminal coordinator's pane does", async () => {
    await as(SESSION_X, 'orchestration.runCreate', { objective: 'first' })
    const current = idOf(
      (await as(SESSION_X, 'orchestration.runCreate', { objective: 'next' })).run
    )

    const { message } = await sendFromTerminal(ADDRESS_X)

    expect(message).toMatchObject({ to_handle: `run:${current}`, run_id: current })
    expect(await as(SESSION_X, 'orchestration.check', {})).toMatchObject({
      runId: current,
      messages: [{ subject: 'hello' }]
    })
  })

  it('delivers it to a chat with no Run, which reads its direct mailbox', async () => {
    const { message } = await sendFromTerminal(ADDRESS_X)

    expect(message).toMatchObject({ to_handle: ADDRESS_X })
    expect(await as(SESSION_X, 'orchestration.check', {})).toMatchObject({
      messages: [{ subject: 'hello' }]
    })
  })

  it('reaches a chat with no Run after a restart, once the send has started the session host', async () => {
    // After restart, start the lazy session host before synchronous recipient-record lookup.
    const store = hostRef.current
    hostRef.current = null
    vi.mocked(h.runtime.ensureStructuredAgentSessionHost).mockImplementation(async () => {
      hostRef.current = store
    })

    const { message } = await sendFromTerminal(ADDRESS_X)

    expect(message).toMatchObject({ to_handle: ADDRESS_X })
  })

  it('refuses an Orca session this host does not run, or has no record of', async () => {
    h.records.set(
      SESSION_X,
      sessionRecord(SESSION_X, { location: { executionHostId: 'ssh:devbox' } })
    )
    h.records.delete(SESSION_Y)

    for (const [to, code] of [
      [ADDRESS_X, 'session_caller_host_boundary'],
      [ADDRESS_Y, 'session_caller_unknown']
    ]) {
      const response = await h.dispatch(
        orchestrationRequest('orchestration.send', { from: WORKER_HANDLE, to, subject: 's' })
      )
      expect(response).toMatchObject({ ok: false, error: { code } })
    }
  })

  it("routes a structured worker's session address to the Dispatch it is working", async () => {
    const handle = mintStructuredWorkerHandle()
    const paneKey = mintStructuredWorkerPaneKey(SESSION_Y)
    structuredWorkerIdentities.register({
      handle,
      sessionId: SESSION_Y,
      agent: 'claude',
      paneKey,
      processIncarnation: structuredWorkerProcessIncarnation(SESSION_Y),
      worktreeId: 'wt_1',
      hostScope: { kind: 'local', hostId: 'local' }
    })
    const runId = idOf((await as(SESSION_X, 'orchestration.runCreate', { objective: 'o' })).run)
    const dispatch = h.db.createDispatchContext({
      taskId: h.db.createTask({ runId, spec: 'work' }).id,
      assigneeHandle: handle,
      assigneePaneKey: paneKey,
      processIncarnation: structuredWorkerProcessIncarnation(SESSION_Y),
      creator: { kind: 'session', orcaSessionId: SESSION_X },
      maxDepth: Number.MAX_SAFE_INTEGER
    })

    const { message } = await as(SESSION_X, 'orchestration.send', {
      to: ADDRESS_Y,
      subject: 'to the worker'
    })

    expect(message).toMatchObject({ to_handle: `dispatch:${dispatch.id}`, run_id: runId })
    expect(await as(SESSION_Y, 'orchestration.check', { peek: true })).toMatchObject({
      dispatchId: dispatch.id,
      messages: [{ subject: 'to the worker' }]
    })
  })
})

describe('attached local send across the actual session-host await', () => {
  let h: SessionCallerHarness
  beforeEach(() => {
    h = createSessionCallerHarness(hostRef)
    attachRemoteDispatch(h.db, h.runtime, 'run-home', {
      paneKey: WORKER_PANE,
      terminalHandle: WORKER_HANDLE
    })
  })
  afterEach(() => {
    h.close()
    vi.restoreAllMocks()
  })

  it.each([false, true])(
    'revalidates the attested process through graph remount, replaced=%s',
    async (replaced) => {
      const token = 'fixture-launch-token'
      const tokenHash = createHash('sha256').update(token).digest('hex')
      const runtime = new OrcaRuntimeService(null, undefined, {
        attestAgentHookCompatibilityAuthority: ({ paneKey, launchTokenHash }) =>
          paneKey === WORKER_PANE && launchTokenHash === tokenHash
            ? { paneKey, source: 'hydrated_commitment' }
            : null
      })
      runtime.setOrchestrationDb(h.db)
      let source: OrchestrationCompatibilityTerminalAuthority = {
        runtimeId: runtime.getRuntimeId(),
        terminalHandle: WORKER_HANDLE,
        ptyId: 'pty-original',
        worktreeId: 'repo::worker',
        paneKey: WORKER_PANE,
        processIncarnation: 'worker_epoch:pty:1',
        launchTokenHash: tokenHash,
        hostScope: { kind: 'local', hostId: 'local' }
      }
      vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockImplementation(() => source)
      vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue(null)
      const evidence = { terminalHandle: WORKER_HANDLE, paneKey: WORKER_PANE, launchToken: token }
      const authority = runtime.verifyOrchestrationCompatibilityCaller(evidence)
      if (!authority) {
        throw new Error('Fixture authority must be verified before sending')
      }
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      vi.spyOn(runtime, 'ensureStructuredAgentSessionHost').mockImplementation(async () => {
        entered.resolve()
        await release.promise
      })
      const method = ORCHESTRATION_SEND_METHODS[0]
      const pending = method.handler(
        method.params.parse({ from: WORKER_HANDLE, to: ADDRESS_X, subject: 'Attested local mail' }),
        {
          runtime,
          orchestrationCompatibilityCallerAuthority: authority,
          orchestrationCompatibilityEvidence: evidence
        }
      )
      const outcome = pending.then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, error })
      )
      await entered.promise
      if (replaced) {
        source = { ...source, processIncarnation: 'successor:pty:2' }
      }
      release.resolve()
      expect(await outcome).toMatchObject(
        replaced
          ? { ok: false, error: { code: 'worker_identity_changed' } }
          : { ok: true, value: { message: { to_handle: ADDRESS_X, from_handle: WORKER_HANDLE } } }
      )
      expect(h.db.getInbox()).toHaveLength(replaced ? 0 : 1)
      runtime.stopOrchestrationFederationRelay()
    }
  )

  it.each([
    'current',
    'stopping',
    'stop_unknown',
    'removed',
    'new_process',
    'new_pane',
    'new_attachment'
  ] as const)('retains captured sender authority when source becomes %s', async (change) => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    vi.mocked(h.runtime.ensureStructuredAgentSessionHost).mockImplementation(async () => {
      entered.resolve()
      await release.promise
    })
    const pending = h.dispatch(
      orchestrationRequest('orchestration.send', {
        from: WORKER_HANDLE,
        to: ADDRESS_X,
        subject: 'After install'
      })
    )
    await entered.promise
    expect(h.db.getInbox()).toEqual([])
    if (['stopping', 'stop_unknown', 'removed', 'new_attachment'].includes(change)) {
      h.db.beginRemoteAttachmentStop('ctx_remote_targeting')
      if (change === 'stop_unknown') {
        h.db.markRemoteAttachmentStopUnknown('ctx_remote_targeting', 'outcome uncertain')
      } else if (change !== 'stopping') {
        h.db.settleRemoteAttachmentStop('ctx_remote_targeting')
      }
    }
    if (change === 'new_process') {
      vi.mocked(h.runtime.getTerminalProcessIncarnation).mockReturnValue('successor:pty:2')
    }
    if (change === 'new_pane') {
      vi.mocked(h.runtime.getTerminalPaneKey).mockReturnValue(
        'tab_other:88888888-8888-4888-8888-888888888888'
      )
    }
    if (change === 'new_attachment') {
      attachRemoteDispatch(h.db, h.runtime, 'run-successor-home', {
        paneKey: WORKER_PANE,
        terminalHandle: WORKER_HANDLE,
        dispatchId: 'ctx_successor'
      })
    }
    release.resolve()
    const response = await pending
    const accepted = change === 'current' || change === 'stop_unknown'
    expect(response).toMatchObject(
      accepted
        ? { ok: true, result: { message: { to_handle: ADDRESS_X } } }
        : {
            ok: false,
            error: { code: change === 'stopping' ? 'dispatch_inactive' : 'worker_identity_changed' }
          }
    )
    expect(h.db.getInbox()).toHaveLength(accepted ? 1 : 0)
    expect(h.db.listPendingFederationRelay('ctx_remote_targeting', 'to_home')).toEqual([])
  })
})
