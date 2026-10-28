import {
  createRestTestRig,
  type RestTestRig
} from '../../../../native-chat/agent-session-wire/structured-agent-session-rest-test-rig'
import { openTestJournalHostDatabase } from '../../../../native-chat/agent-session-journal/journal-host-database-test-support'
import { setStructuredAgentSessionHost } from '../../../../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  HOST_TEST_NOW,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId
} from '../../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import {
  createStructuredWorkerSession,
  releaseStructuredWorkerSession
} from '../orchestration-structured-worker-session'
import { structuredWorkerIdentities } from '../../../structured-worker-identity'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../../shared/agent-session-journal-types'
import { computeAgentSessionPayloadFingerprint } from '../../../../../shared/agent-session-mutation-envelope'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { partialRuntimeStore } from '../../../runtime-store-partial-fixture'
import type { RpcContext } from '../../core'
import { createOrchestrationRpcHarness } from './rpc-test-harness'
import type { OrchestrationDb } from '../../../orchestration/db'
import { OrchestrationError } from '../../../orchestration/orchestration-error'

type CliRuntimeClient = {
  isRemote?: boolean
  call: <T>(method: string, params?: unknown, options?: unknown) => Promise<{ result: T }>
}

type CliHandler = (ctx: {
  flags: Map<string, string | boolean>
  client: CliRuntimeClient
  cwd: string
  json: boolean
}) => Promise<void>

const originalTerminalHandle = process.env.ORCA_TERMINAL_HANDLE

describe('orchestration CLI/runtime boundary', () => {
  const h = createOrchestrationRpcHarness()
  const { findMethod } = h
  let db: OrchestrationDb
  let ctx: RpcContext
  let rig: RestTestRig | undefined
  const structuredDispatches: string[] = []
  const originalExitCode = process.exitCode

  afterEach(async () => {
    for (const dispatchId of structuredDispatches.splice(0)) {
      releaseStructuredWorkerSession(dispatchId, ctx.runtime)
    }
    if (rig) {
      rig.adapter.closeSession.mockResolvedValue(true)
      openTestJournalHostDatabase(rig.root).db.exec(
        'DROP TRIGGER IF EXISTS cli_refuse_lease_release'
      )
      await rig.dispose()
      rig = undefined
    }
    setStructuredAgentSessionHost(null)
    structuredWorkerIdentities.clear()
    vi.useRealTimers()
    process.exitCode = originalExitCode
    h.cleanup()
    restoreTerminalHandle()
    vi.doUnmock('../../../../../cli/format')
    vi.doUnmock('../../../../../cli/runtime-client')
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    vi.resetModules()
  })

  /** Bridges CLI client calls into the in-memory RPC harness without bypassing RPC param parsing. */
  async function callRpc(name: string, params: Record<string, unknown>) {
    const method = findMethod(name)
    const parsed = method.params ? method.params.parse(params) : undefined
    return method.handler(parsed, ctx)
  }

  function client(): CliRuntimeClient {
    return {
      isRemote: false,
      /** Preserves terminal-handle validation while routing other calls through runtime RPC. */
      async call<T>(method: string, params?: unknown): Promise<{ result: T }> {
        if (method === 'terminal.resolveIdentity') {
          return {
            result: { identity: { handle: objectParams(params).terminal, live: true } } as T
          }
        }
        try {
          return { result: (await callRpc(method, objectParams(params))) as T }
        } catch (error) {
          if (!(error instanceof OrchestrationError)) {
            throw error
          }
          const cliClientPath = '../../../../../cli/runtime-client'
          const {
            RuntimeClientError
          }: {
            RuntimeClientError: new (code: string, message: string, data?: unknown) => Error
          } = await import(cliClientPath)
          throw new RuntimeClientError(error.code, error.message, error.data)
        }
      }
    }
  }

  it('creates and gates a PowerShell-stripped dependency through CLI and runtime', async () => {
    ;({ db, ctx } = h.setup())
    process.env.ORCA_TERMINAL_HANDLE = 'term_coord'
    const handlers = await loadOrchestrationHandlers()
    const runtimeClient = client()

    await runCli(handlers['orchestration task-create'], runtimeClient, [['spec', 'parent work']])
    const parent = taskBySpec('parent work')

    await runCli(handlers['orchestration task-create'], runtimeClient, [
      ['spec', 'child work'],
      ['deps', `[${parent.id}]`]
    ])
    const child = taskBySpec('child work')

    expect(child.status).toBe('pending')
    expect(child.deps).toBe(JSON.stringify([parent.id]))
    await expect(
      runCli(handlers['orchestration dispatch'], runtimeClient, [
        ['task', child.id],
        ['to', 'term_worker']
      ])
    ).rejects.toThrow('only ready tasks can be dispatched')

    await runCli(handlers['orchestration task-update'], runtimeClient, [
      ['id', parent.id],
      ['status', 'completed']
    ])
    expect(db.getTask(child.id)?.status).toBe('ready')

    await runCli(handlers['orchestration dispatch'], runtimeClient, [
      ['task', child.id],
      ['to', 'term_worker']
    ])
    expect(db.getTask(child.id)?.status).toBe('dispatched')
    expect(db.getDispatchContext(child.id)?.assignee_handle).toBe('term_worker')
  })

  it.each([null, 15])('CLI argv preserves worker commands (%s minutes)', async (interval) => {
    const store = partialRuntimeStore({
      getSettings: () => ({
        orchestrationHeartbeatsEnabled: interval !== null,
        orchestrationHeartbeatIntervalMinutes: interval ?? 5
      })
    })
    ;({ db, ctx } = h.setup(true, store))
    const { runtime } = ctx
    process.env.ORCA_TERMINAL_HANDLE = 'term_coord'
    vi.stubEnv('ORCA_PAIRING_CODE', '')
    vi.stubEnv('ORCA_ENVIRONMENT', '')
    vi.stubEnv('ORCA_AGENT_SESSION_ID', '')
    vi.doMock('../../../../../cli/runtime-client', async (importOriginal) => ({
      ...(await importOriginal<Record<string, unknown>>()),
      RuntimeClient: client
    }))
    const output = vi.fn()
    vi.doMock('../../../../../cli/format', () => ({ printResult: output }))
    vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockImplementation((handle) =>
      handle === 'term_worker'
        ? {
            runtimeId: runtime.getRuntimeId(),
            terminalHandle: handle,
            ptyId: 'pty_worker',
            worktreeId: 'wt_worker',
            paneKey: 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            processIncarnation: 'worker:1',
            launchTokenHash: null,
            hostScope: { kind: 'local', hostId: 'local' }
          }
        : null
    )
    vi.spyOn(runtime, 'isTerminalRunningAgent').mockResolvedValue(true)
    const delivered = vi
      .spyOn(runtime, 'sendTerminalAgentPrompt')
      .mockResolvedValue({ handle: 'term_worker', accepted: true, bytesWritten: 1 })
    const task = db.createTask({ spec: 'complete work and report the outcome' })
    const cliPath = '../../../../../cli/index'
    const { main }: { main(argv: string[]): Promise<void> } = await import(cliPath)
    await main([
      'orchestration',
      'dispatch',
      '--task',
      task.id,
      '--to',
      'term_worker',
      '--inject',
      '--return-preamble',
      '--json'
    ])
    expect(output).toHaveBeenCalledOnce()
    const result = output.mock.calls[0][0].result
    expect(result.injected).toBe(true)
    expect(db.getTask(task.id)?.status).toBe('dispatched')
    expect(delivered).toHaveBeenCalledExactlyOnceWith(
      'term_worker',
      result.preamble,
      expect.anything()
    )
    if (interval === null) {
      expect(result.preamble).not.toMatch(/heartbeat/i)
    } else {
      expect(result.preamble).toContain('Send a heartbeat every 15 minutes')
    }
    for (const command of [
      '--type worker_done',
      '--outcome succeeded',
      '--outcome failed',
      'orchestration ask --from',
      '--type escalation',
      'orchestration check --terminal'
    ]) {
      expect(result.preamble).toContain(command)
    }
  })

  it.each(['proven', 'lease-release-failed', 'failed-close'] as const)(
    'CLI Stop/read/release preserves the actual structured close outcome: %s',
    async (closeKind) => {
      ;({ db, ctx } = h.setup(true, partialRuntimeStore()))
      const { runtime } = ctx
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
      vi.setSystemTime(HOST_TEST_NOW)
      rig = await createRestTestRig()
      const { host, store, adapter } = rig
      setStructuredAgentSessionHost(host)
      // External installation and workspace/account lookup; creation, binding and lifecycle stay real.
      vi.spyOn(runtime, 'ensureStructuredAgentSessionHost').mockResolvedValue(undefined)
      vi.spyOn(runtime, 'resolveStructuredAgentSessionCreateIntent').mockImplementation(
        async (input) =>
          hostTestAttachParams(null, {
            providerHandle: undefined,
            envelope: {
              ...input.envelope,
              expectedRuntimeFence: null,
              payloadFingerprint: ''
            }
          })
      )
      const notify = vi.spyOn(runtime, 'notifyStructuredSessionJournalActivity')
      const forget = vi.spyOn(runtime, 'forgetStructuredSessionMail')
      const subscriptions = new Map<string, ReturnType<typeof vi.fn<() => void>>>()
      const observe = host.observeJournalPublications.bind(host)
      vi.spyOn(host, 'observeJournalPublications').mockImplementation((sessionId, listener) => {
        const dispose = vi.fn(observe(sessionId, listener))
        subscriptions.set(sessionId, dispose)
        return dispose
      })
      const start = async (spec: string) => {
        const task = db.createTask({ spec })
        const { dispatch } = db.createStartingWorkerDispatch({
          taskId: task.id,
          startOptions: {},
          creator: { kind: 'system' },
          maxDepth: 9,
          runtimeEpoch: runtime.getRuntimeId()
        })
        structuredDispatches.push(dispatch.id)
        const { identity } = await createStructuredWorkerSession({
          runtime,
          worktreeId: 'workspace-1',
          agent: 'codex',
          dispatchId: dispatch.id,
          onJournalActivity: (id) => runtime.notifyStructuredSessionJournalActivity(id)
        })
        db.prepareStartingWorkerAuthority({
          dispatchId: dispatch.id,
          handle: identity.handle,
          paneKey: identity.paneKey,
          processIncarnation: identity.processIncarnation,
          worktreeId: identity.worktreeId,
          effects: [],
          setupState: 'not_configured',
          terminalOwnership: 'created',
          hostScope: JSON.stringify(identity.hostScope)
        })
        db.markWorkerDispatchReady(dispatch.id)
        const session = host.collaboratorsForTests().sessions.get(identity.sessionId)
        if (!session) {
          throw new Error('The actual worker create did not open its journal')
        }
        const append = (text: string) =>
          session.journal.appendItem(
            { provider: 'orca', clientMessageId: text },
            { kind: 'status', text },
            {
              fence: store.requireWritableRecord(identity.sessionId).lease.runtimeFence,
              turnScope: AGENT_JOURNAL_THREAD_SCOPE
            }
          )
        return { identity, dispatch, task, journal: session.journal, append }
      }
      const worker = await start('worker with retained output')
      const sibling = await start('sibling must stay bound')
      const sessionId = worker.identity.sessionId
      const body = hostTestMessage('Retain this worker output')
      const sent = await host.send(
        { callerKey: 'cli-lifecycle-fixture' },
        {
          envelope: {
            sessionId,
            clientOperationId: hostTestOperationId(),
            expectedRuntimeFence: store.requireWritableRecord(sessionId).lease.runtimeFence,
            payloadFingerprint: computeAgentSessionPayloadFingerprint({
              method: 'agentSession.send',
              sessionId,
              fields: { body }
            })
          },
          body
        }
      )
      expect(sent.ok).toBe(true)
      await vi.waitFor(() => expect(adapter.dispatch).toHaveBeenCalledOnce())
      const mailbox = `dispatch:${worker.dispatch.id}`
      const held = db.insertMessage({
        from: 'term_coord',
        to: mailbox,
        subject: 'Held by the current turn',
        deliveryContract: 'current_delivery'
      })
      expect(
        db
          .getOrCreateMailboxDelivery({
            runId: db.getDispatchContextById(worker.dispatch.id)!.run_id,
            mailboxHandle: mailbox,
            consumerGeneration: db.getDispatchContextById(worker.dispatch.id)!.consumer_generation
          })
          ?.messages.map((message) => message.id)
      ).toEqual([held.id])
      const pending = db.insertMessage({
        from: 'term_coord',
        to: mailbox,
        subject: 'Never redrive after a completed close'
      })
      await worker.journal.appendItem(
        { provider: 'orca', clientMessageId: 'busy-turn' },
        { kind: 'turn', turnId: 'busy-turn', state: 'running' },
        {
          fence: store.requireWritableRecord(sessionId).lease.runtimeFence,
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        }
      )
      expect(host.currentWork(sessionId)?.working()).toBe(true)
      runtime.deliverPendingMessagesForHandle(mailbox)
      await vi.advanceTimersByTimeAsync(300)
      expect(db.getMessageById(pending.id)?.delivered_at).toBeNull()
      adapter.dispatch.mockClear()
      notify.mockClear()
      await worker.append('publication queued before close')
      const childBeforeClose = host.collaboratorsForTests().sessions.get(sessionId)?.child
      const leaseBeforeClose = store.getRecord(sessionId)?.lease
      expect(childBeforeClose).toBeTruthy()
      if (closeKind === 'lease-release-failed') {
        // Fail the actual durable release write, preserving the real transition/rollback owners.
        openTestJournalHostDatabase(rig.root).db.exec(`
          CREATE TEMP TRIGGER cli_refuse_lease_release BEFORE UPDATE ON agent_session_records
          WHEN json_extract(NEW.record_json, '$.lease.claimStatus') = 'released'
          BEGIN SELECT RAISE(ABORT, 'fixture disk full'); END
        `)
      }
      const close = vi.spyOn(host, 'close')
      adapter.closeSession.mockResolvedValue(closeKind !== 'failed-close')
      for (const name of ['ORCA_PAIRING_CODE', 'ORCA_ENVIRONMENT', 'ORCA_AGENT_SESSION_ID']) {
        vi.stubEnv(name, '')
      }
      process.env.ORCA_TERMINAL_HANDLE = 'term_coord'
      vi.doMock('../../../../../cli/runtime-client', async (importOriginal) => ({
        ...(await importOriginal<Record<string, unknown>>()),
        RuntimeClient: client
      }))
      const output = vi.fn()
      const printed = vi.spyOn(console, 'log').mockImplementation(() => {})
      vi.doMock('../../../../../cli/format', () => ({ printResult: output }))
      const cliPath = '../../../../../cli/index'
      const { main }: { main(argv: string[]): Promise<void> } = await import(cliPath)
      const command = async (name: string, extra: string[] = []) => {
        output.mockClear()
        process.exitCode = undefined
        await main(['orchestration', name, '--dispatch', worker.dispatch.id, ...extra, '--json'])
        expect(output).toHaveBeenCalledOnce()
        return output.mock.calls[0][0].result
      }
      const refusedCommand = async (
        name: string,
        code: string,
        message: string,
        extra: string[] = []
      ) => {
        output.mockClear()
        printed.mockClear()
        process.exitCode = undefined
        await main(['orchestration', name, '--dispatch', worker.dispatch.id, ...extra, '--json'])
        expect(process.exitCode).toBe(1)
        expect(output).not.toHaveBeenCalled()
        expect(printed).toHaveBeenCalledOnce()
        const error: unknown = JSON.parse(String(printed.mock.calls[0][0]))
        expect(error).toMatchObject({
          ok: false,
          error: { code, message: expect.stringContaining(message) }
        })
      }
      const stopped = await command('worker-stop')
      expect(stopped).toMatchObject({
        state: closeKind === 'proven' ? 'stopped' : 'stop_unknown',
        processAction: 'closed_agent_terminal'
      })
      expect(process.exitCode).toBe(closeKind === 'proven' ? undefined : 1)
      expect(db.getWorkerDispatch(worker.dispatch.id)?.state).toBe(stopped.state)
      expect(db.getDispatchContextById(worker.dispatch.id)?.status).toBe(
        closeKind === 'proven' ? 'failed' : 'dispatched'
      )
      expect(close).toHaveBeenCalledExactlyOnceWith(sessionId, 'evict')
      expect(adapter.closeSession).toHaveBeenCalledExactlyOnceWith(sessionId, undefined)
      if (closeKind === 'lease-release-failed') {
        expect(store.getRecord(sessionId)?.lease.claimStatus).toBe('live')
        expect(host.collaboratorsForTests().sessions.get(sessionId)?.lastEndedChild).toMatchObject({
          rootGone: true
        })
      }
      await vi.advanceTimersByTimeAsync(300)
      if (closeKind !== 'failed-close') {
        expect(subscriptions.get(sessionId)).toHaveBeenCalledOnce()
        expect(forget).toHaveBeenCalledWith(sessionId)
        expect(notify).not.toHaveBeenCalledWith(sessionId)
        const snapshot = vi.spyOn(host, 'journalSnapshot')
        runtime.notifyStructuredSessionJournalActivity(sessionId)
        expect(snapshot).not.toHaveBeenCalled()
      } else {
        expect(subscriptions.get(sessionId)).not.toHaveBeenCalled()
        expect(forget).not.toHaveBeenCalledWith(sessionId)
        expect(host.collaboratorsForTests().sessions.get(sessionId)?.child).toBe(childBeforeClose)
        expect(store.getRecord(sessionId)?.lease).toEqual(leaseBeforeClose)
        expect(structuredWorkerIdentities.get(worker.identity.handle)).toEqual(worker.identity)
      }
      const current = await command('worker-read', ['--source', 'transcript'])
      expect(current.source).toBe('transcript')
      expect(JSON.stringify(current.transcript.messages)).toContain('Retain this worker output')
      expect(current.status.liveness).toBe(closeKind === 'proven' ? 'exited' : 'live')
      const newer = await start('newer worker must stay bound')
      const siblingResource = db.getWorkerTerminalResourceByOwner(sibling.dispatch.id)
      const newerResource = db.getWorkerTerminalResourceByOwner(newer.dispatch.id)
      if (closeKind === 'proven') {
        const release = await command('worker-release')
        const repeated = await command('worker-release')
        expect(release).toMatchObject({ state: 'released', archive: { status: 'unavailable' } })
        expect(repeated).toMatchObject({ state: 'already_released', processAction: 'none' })
        await refusedCommand(
          'worker-read',
          'archive_unavailable',
          'without a preserved output archive',
          ['--source', 'transcript']
        )
        const history = await host.history({ sessionId, direction: 'tail' })
        expect(history.ok).toBe(true)
        if (!history.ok) {
          throw new Error('The retained conversation history could not be read')
        }
        expect(JSON.stringify(history.page.items)).toContain('Retain this worker output')
      } else {
        const resourceBeforeRelease = db.getWorkerTerminalResourceByOwner(worker.dispatch.id)
        for (let attempt = 0; attempt < 2; attempt += 1) {
          await refusedCommand(
            'worker-release',
            'dispatch_inactive',
            'stop_unknown; only a settled worker can release'
          )
        }
        expect(db.getWorkerDispatch(worker.dispatch.id)?.state).toBe('stop_unknown')
        expect(db.getWorkerTerminalResourceByOwner(worker.dispatch.id)).toEqual(
          resourceBeforeRelease
        )
      }
      expect(adapter.closeSession).toHaveBeenCalledExactlyOnceWith(sessionId, undefined)
      notify.mockClear()
      await sibling.append('sibling still has a retry edge')
      await newer.append('newer still has a retry edge')
      await vi.advanceTimersByTimeAsync(300)
      expect(db.getWorkerTerminalResourceByOwner(sibling.dispatch.id)).toEqual(siblingResource)
      expect(db.getWorkerTerminalResourceByOwner(newer.dispatch.id)).toEqual(newerResource)
      expect(structuredWorkerIdentities.get(sibling.identity.handle)).toEqual(sibling.identity)
      expect(structuredWorkerIdentities.get(newer.identity.handle)).toEqual(newer.identity)
      expect(subscriptions.get(sibling.identity.sessionId)).not.toHaveBeenCalled()
      expect(subscriptions.get(newer.identity.sessionId)).not.toHaveBeenCalled()
      expect(notify).toHaveBeenCalledWith(sibling.identity.sessionId)
      expect(notify).toHaveBeenCalledWith(newer.identity.sessionId)
      expect(adapter.dispatch).not.toHaveBeenCalled()
      expect(db.getMessageById(pending.id)?.delivered_at).toBeNull()
    }
  )

  function taskBySpec(spec: string) {
    const task = db.listTasks().find((candidate) => candidate.spec === spec)
    if (!task) {
      throw new Error(`Expected task with spec: ${spec}`)
    }
    return task
  }
})

/** Imports orchestration handlers after mocking output so the test observes state, not stdout. */
async function loadOrchestrationHandlers(): Promise<Record<string, CliHandler>> {
  vi.doMock('../../../../../cli/format', () => ({ printResult: vi.fn() }))
  const cliModulePath = '../../../../../cli/handlers/orchestration'
  const module = (await import(cliModulePath)) as {
    ORCHESTRATION_HANDLERS: Record<string, CliHandler>
  }
  return module.ORCHESTRATION_HANDLERS
}

async function runCli(
  handler: CliHandler,
  client: CliRuntimeClient,
  entries: [string, string | boolean][]
): Promise<void> {
  await handler({
    flags: new Map<string, string | boolean>(entries),
    client,
    cwd: process.cwd(),
    json: true
  })
}

/** Narrows optional RPC params into the object shape expected by the RPC parser. */
function objectParams(params: unknown): Record<string, unknown> {
  return params && typeof params === 'object' ? (params as Record<string, unknown>) : {}
}

/** Restores the caller terminal environment so later CLI tests do not inherit this fixture. */
function restoreTerminalHandle(): void {
  if (originalTerminalHandle === undefined) {
    delete process.env.ORCA_TERMINAL_HANDLE
  } else {
    process.env.ORCA_TERMINAL_HANDLE = originalTerminalHandle
  }
}
