import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import type { query } from '@anthropic-ai/claude-agent-sdk'
import {
  CLAUDE_READER_DRAIN_AFTER_EXIT_MS,
  openClaudeStreamJsonConnection,
  type ClaudeStreamJsonLaunch
} from './claude-stream-json-connection'

const mocks = vi.hoisted(() => {
  const refresh = vi.fn()
  const proveClaudeChildExit = vi.fn()
  const tree = {
    capture: vi.fn(async () => {}),
    refresh: (...args: unknown[]) => refresh(...args),
    reap: vi.fn(async () => 'exited' as const),
    treeVerdict: 'unverifiable' as const,
    forcedReapAttempted: false
  }
  return { proveClaudeChildExit, refresh, tree }
})

vi.mock('./claude-agent-sdk-exit-proof', () => ({
  createClaudeChildTreeReaper: vi.fn(() => mocks.tree),
  proveClaudeChildExit: (...args: unknown[]) => mocks.proveClaudeChildExit(...args)
}))

function fakeChild(
  streams: { stdout: PassThrough; stderr: PassThrough } = {
    stdout: new PassThrough(),
    stderr: new PassThrough()
  }
): ChildProcessWithoutNullStreams {
  const child = new EventEmitter()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The connection reads only pid, the three pipes and kill, which this fake carries.
  return Object.assign(child, {
    pid: 424242,
    stdin: new PassThrough(),
    stdout: streams.stdout,
    stderr: streams.stderr,
    kill: vi.fn()
  }) as unknown as ChildProcessWithoutNullStreams
}

describe('Claude stream-json close ordering', () => {
  it('stops pulling SDK messages until reading resumes', async () => {
    mocks.refresh.mockReset()
    mocks.proveClaudeChildExit.mockReset()
    mocks.refresh.mockResolvedValue(undefined)
    mocks.proveClaudeChildExit.mockResolvedValue(true)
    const child = fakeChild()
    const first = Promise.withResolvers<Record<string, unknown>>()
    const next = vi
      .fn<() => Promise<IteratorResult<Record<string, unknown>>>>()
      .mockImplementationOnce(async () => ({ value: await first.promise, done: false }))
      .mockResolvedValueOnce({ value: { type: 'second' }, done: false })
      .mockResolvedValue({ value: undefined, done: true })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This injected query exercises only the async iterator used by the connection.
    const queryImpl = ((params: Parameters<typeof query>[0]) => {
      params.options?.spawnClaudeCodeProcess?.({
        command: 'claude',
        args: [],
        env: {},
        signal: new AbortController().signal
      })
      return {
        [Symbol.asyncIterator]: () => ({ next })
      }
    }) as unknown as typeof query
    const seen: string[] = []
    let connection: Awaited<ReturnType<typeof openClaudeStreamJsonConnection>>
    connection = await openClaudeStreamJsonConnection(
      { pathToClaudeCodeExecutable: 'claude', options: {}, cwd: '/work/repo' },
      {
        onMessage: (message) => {
          seen.push(String(message.type))
          if (message.type === 'first') {
            connection.pauseReading?.()
          }
        }
      },
      () => child,
      queryImpl
    )

    first.resolve({ type: 'first' })
    await vi.waitFor(() => expect(seen).toEqual(['first']))
    await new Promise((resolve) => setImmediate(resolve))
    expect(next).toHaveBeenCalledOnce()

    connection.resumeReading?.()
    await vi.waitFor(() => expect(seen).toEqual(['first', 'second']))
    expect(next).toHaveBeenCalledTimes(3)
    await expect(connection.close()).resolves.toBe(true)
  })

  it('keeps a pulled frame under delivery pressure after provider exit until its drain wake', async () => {
    mocks.refresh.mockReset()
    mocks.proveClaudeChildExit.mockReset()
    mocks.refresh.mockResolvedValue(undefined)
    mocks.proveClaudeChildExit.mockResolvedValue(true)
    const child = fakeChild()
    const first = Promise.withResolvers<Record<string, unknown>>()
    const next = vi
      .fn<() => Promise<IteratorResult<Record<string, unknown>>>>()
      .mockImplementationOnce(async () => ({ value: await first.promise, done: false }))
      .mockResolvedValue({ value: undefined, done: true })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This injected query exercises only the async iterator used by the connection.
    const queryImpl = ((params: Parameters<typeof query>[0]) => {
      params.options?.spawnClaudeCodeProcess?.({
        command: 'claude',
        args: [],
        env: {},
        signal: new AbortController().signal
      })
      return {
        [Symbol.asyncIterator]: () => ({ next })
      }
    }) as unknown as typeof query
    const events: string[] = []
    const connection = await openClaudeStreamJsonConnection(
      { pathToClaudeCodeExecutable: 'claude', options: {}, cwd: '/work/repo' },
      {
        onMessage: (message) => events.push(`message:${String(message.type)}`),
        onExit: () => events.push('exit')
      },
      () => child,
      queryImpl
    )

    connection.pauseReading?.()
    first.resolve({ type: 'task_notification' })
    await vi.waitFor(() => expect(next).toHaveBeenCalledOnce())
    expect(events).toEqual([])

    child.emit('exit', 1, null)
    await vi.waitFor(() => expect(events).toEqual(['exit']))
    connection.resumeReading?.()
    await vi.waitFor(() => expect(events).toEqual(['exit', 'message:task_notification']))
    await expect(connection.close()).resolves.toBe(true)
  })

  it('reports an exit whose stdout ended first once the exit is seen, with its usual reason', async () => {
    mocks.refresh.mockReset()
    mocks.proveClaudeChildExit.mockReset()
    mocks.refresh.mockResolvedValue(undefined)
    mocks.proveClaudeChildExit.mockResolvedValue(true)
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = fakeChild({ stdout, stderr })
    const next = vi
      .fn<() => Promise<IteratorResult<Record<string, unknown>>>>()
      .mockResolvedValue({ value: undefined, done: true })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This injected query exercises only the async iterator used by the connection.
    const queryImpl = ((params: Parameters<typeof query>[0]) => {
      params.options?.spawnClaudeCodeProcess?.({
        command: 'claude',
        args: [],
        env: {},
        signal: new AbortController().signal
      })
      return {
        [Symbol.asyncIterator]: () => ({ next })
      }
    }) as unknown as typeof query
    const exits: string[] = []
    const connection = await openClaudeStreamJsonConnection(
      { pathToClaudeCodeExecutable: 'claude', options: {}, cwd: '/work/repo' },
      { onExit: (error, exit) => exits.push(`${exit?.expected}: ${error.message}`) },
      () => child,
      queryImpl
    )

    stderr.write('session limit reached\n')
    stdout.end()
    await vi.waitFor(() => expect(next).toHaveBeenCalledOnce())
    await new Promise((resolve) => setImmediate(resolve))
    expect(exits).toEqual([])

    child.emit('exit', 1, null)
    await vi.waitFor(() =>
      expect(exits).toEqual(['false: claude stream-json exited (code 1): session limit reached'])
    )
    await connection.close()
  })

  it('returns an unproven close without waiting on a live output reader', async () => {
    mocks.refresh.mockReset()
    mocks.proveClaudeChildExit.mockReset()
    mocks.refresh.mockResolvedValue(undefined)
    mocks.proveClaudeChildExit.mockResolvedValue(false)
    const child = fakeChild()
    const next = vi.fn(() => new Promise<IteratorResult<Record<string, unknown>>>(() => {}))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This injected query exercises only the async iterator used by the connection.
    const queryImpl = ((params: Parameters<typeof query>[0]) => {
      params.options?.spawnClaudeCodeProcess?.({
        command: 'claude',
        args: [],
        env: {},
        signal: new AbortController().signal
      })
      return {
        [Symbol.asyncIterator]: () => ({ next })
      }
    }) as unknown as typeof query
    const connection = await openClaudeStreamJsonConnection(
      { pathToClaudeCodeExecutable: 'claude', options: {}, cwd: '/work/repo' },
      {},
      () => child,
      queryImpl
    )

    await expect(connection.close()).resolves.toBe(false)
    expect(next).toHaveBeenCalledOnce()
  })

  it('runs the stop ladder again on a close after an unproven attempt, refusing input meanwhile', async () => {
    mocks.refresh.mockReset()
    mocks.proveClaudeChildExit.mockReset()
    mocks.refresh.mockResolvedValue(undefined)
    mocks.proveClaudeChildExit.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const child = fakeChild()
    const next = vi.fn(async (): Promise<IteratorResult<Record<string, unknown>>> => ({
      value: undefined,
      done: true
    }))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This injected query exercises only the async iterator used by the connection.
    const queryImpl = ((params: Parameters<typeof query>[0]) => {
      params.options?.spawnClaudeCodeProcess?.({
        command: 'claude',
        args: [],
        env: {},
        signal: new AbortController().signal
      })
      return {
        [Symbol.asyncIterator]: () => ({ next })
      }
    }) as unknown as typeof query
    const connection = await openClaudeStreamJsonConnection(
      { pathToClaudeCodeExecutable: 'claude', options: {}, cwd: '/work/repo' },
      {},
      () => child,
      queryImpl
    )

    await expect(connection.close()).resolves.toBe(false)
    await expect(connection.send({ type: 'user' })).rejects.toThrow()
    await expect(connection.close()).resolves.toBe(true)
    expect(mocks.proveClaudeChildExit).toHaveBeenCalledTimes(2)
  })

  // Inherited pipes must not keep sends and Stops waiting after proven exit.
  it('resolves a proven close though the output never ends', async () => {
    mocks.refresh.mockReset()
    mocks.proveClaudeChildExit.mockReset()
    mocks.refresh.mockResolvedValue(undefined)
    mocks.proveClaudeChildExit.mockResolvedValue(true)
    const child = fakeChild()
    const next = vi.fn(() => new Promise<IteratorResult<Record<string, unknown>>>(() => {}))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This injected query exercises only the async iterator used by the connection.
    const queryImpl = ((params: Parameters<typeof query>[0]) => {
      params.options?.spawnClaudeCodeProcess?.({
        command: 'claude',
        args: [],
        env: {},
        signal: new AbortController().signal
      })
      return {
        [Symbol.asyncIterator]: () => ({ next })
      }
    }) as unknown as typeof query
    const connection = await openClaudeStreamJsonConnection(
      { pathToClaudeCodeExecutable: 'claude', options: {}, cwd: '/work/repo' },
      {},
      () => child,
      queryImpl
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.useFakeTimers()
    try {
      let closed: boolean | undefined
      void connection.close().then((value) => {
        closed = value
      })
      await vi.advanceTimersByTimeAsync(CLAUDE_READER_DRAIN_AFTER_EXIT_MS - 1)
      expect(closed).toBeUndefined()
      await vi.advanceTimersByTimeAsync(1)
      expect(closed).toBe(true)
      await expect(connection.outputDrained).rejects.toThrow('output did not drain')
    } finally {
      vi.useRealTimers()
      warn.mockRestore()
    }
  })

  it('reports a root that exits after its close came back unproven as that close ending', async () => {
    mocks.refresh.mockReset()
    mocks.proveClaudeChildExit.mockReset()
    mocks.refresh.mockResolvedValue(undefined)
    mocks.proveClaudeChildExit.mockResolvedValue(false)
    const child = fakeChild()
    const next = vi.fn(() => new Promise<IteratorResult<Record<string, unknown>>>(() => {}))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This injected query exercises only the async iterator used by the connection.
    const queryImpl = ((params: Parameters<typeof query>[0]) => {
      params.options?.spawnClaudeCodeProcess?.({
        command: 'claude',
        args: [],
        env: {},
        signal: new AbortController().signal
      })
      return {
        [Symbol.asyncIterator]: () => ({ next })
      }
    }) as unknown as typeof query
    const exits: (boolean | undefined)[] = []
    const connection = await openClaudeStreamJsonConnection(
      { pathToClaudeCodeExecutable: 'claude', options: {}, cwd: '/work/repo' },
      { onExit: (_error, exit) => exits.push(exit?.expected) },
      () => child,
      queryImpl
    )
    await expect(connection.close()).resolves.toBe(false)

    child.emit('exit', 0, 'SIGTERM')

    expect(exits).toEqual([true])
  })

  it('waits for the live tree refresh before ending stdin', async () => {
    const refreshDone = Promise.withResolvers<void>()
    mocks.refresh.mockReturnValueOnce(refreshDone.promise)
    mocks.proveClaudeChildExit.mockResolvedValueOnce(true)
    const child = fakeChild()
    const launch: ClaudeStreamJsonLaunch = {
      pathToClaudeCodeExecutable: 'claude',
      options: {},
      cwd: '/work/repo'
    }
    const queryImpl = ((params: Parameters<typeof query>[0]) => {
      if (!params.options) {
        throw new Error('missing SDK options')
      }
      params.options.spawnClaudeCodeProcess?.({
        command: 'claude',
        args: [],
        env: {},
        signal: new AbortController().signal
      })
      void (async () => {
        for await (const _message of params.prompt) {
          // The SDK owns the transport write; the close test only needs its EOF boundary.
        }
        child.stdin.end()
      })()
      return (async function* () {})()
    }) as typeof query
    const connection = await openClaudeStreamJsonConnection(launch, {}, () => child, queryImpl)

    const closing = connection.close()
    await new Promise((resolve) => setImmediate(resolve))
    expect(child.stdin.writableEnded).toBe(false)

    refreshDone.resolve()
    await expect(closing).resolves.toBe(true)
    expect(child.stdin.writableEnded).toBe(true)
  })

  it('requests a fresh close boundary after an output capture starts', async () => {
    mocks.refresh.mockReset()
    mocks.proveClaudeChildExit.mockReset()
    const outputCapture = Promise.withResolvers<void>()
    const closeCapture = Promise.withResolvers<void>()
    mocks.refresh
      .mockReturnValueOnce(outputCapture.promise)
      .mockReturnValueOnce(closeCapture.promise)
    mocks.proveClaudeChildExit.mockResolvedValueOnce(true)
    const child = fakeChild()
    const launch: ClaudeStreamJsonLaunch = {
      pathToClaudeCodeExecutable: 'claude',
      options: {},
      cwd: '/work/repo'
    }
    const queryImpl = ((params: Parameters<typeof query>[0]) => {
      params.options?.spawnClaudeCodeProcess?.({
        command: 'claude',
        args: [],
        env: {},
        signal: new AbortController().signal
      })
      void (async () => {
        for await (const _message of params.prompt) {
          // The SDK owns the transport write; the close test only needs its EOF boundary.
        }
        child.stdin.end()
      })()
      return (async function* () {})()
    }) as typeof query
    const connection = await openClaudeStreamJsonConnection(launch, {}, () => child, queryImpl)

    child.stderr.emit('data', 'output')
    await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1))
    const closing = connection.close()
    await Promise.resolve()

    expect(mocks.refresh).toHaveBeenCalledTimes(2)
    expect(child.stdin.writableEnded).toBe(false)

    outputCapture.resolve()
    await Promise.resolve()
    expect(child.stdin.writableEnded).toBe(false)
    closeCapture.resolve()
    await expect(closing).resolves.toBe(true)
    expect(child.stdin.writableEnded).toBe(true)
  })
})

it.each(['healthy', 'database-failure'] as const)(
  'hands pulled exit output through the actual host tail before disposal and fence release: %s',
  async (outcome) => {
    const { checkpointJournalRig, closeCheckpointTestJournals } =
      await import('./claude-checkpoint-test-support')
    const { bindClaudeConnectionJournalControls } =
      await import('./claude-structured-session-journal-control')
    const { endExitedStructuredAgentSessionChildUnderSerialize } =
      await import('../native-chat/agent-session-wire/structured-agent-session-child-exit')
    const { agentSessionLeaseFixture, agentSessionRecordFixture } =
      await import('../../shared/agent-session-record.test-fixture')
    const { openTestJournalHostDatabase } =
      await import('../native-chat/agent-session-journal/journal-host-database-test-support')
    const r = await checkpointJournalRig({
      watermarks: {
        maxQueuedOperations: 1,
        maxLifecycleQueuedOperations: 1,
        lowQueuedOperations: 0,
        lowQueuedBytes: 0
      }
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.useFakeTimers()
    vi.setSystemTime(0)
    try {
      r.stream({ type: 'message_start', message: { id: 'reply', role: 'assistant', content: [] } })
      r.stream({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'prefix' }
      })
      vi.advanceTimersByTime(60)
      await r.deferred.drained()
      const child = fakeChild()
      mocks.refresh.mockResolvedValue(undefined)
      mocks.proveClaudeChildExit.mockImplementation(async () => {
        child.emit('exit', 0, null)
        return true
      })
      const pulled = Promise.withResolvers<Record<string, unknown>>()
      const next = vi
        .fn<() => Promise<IteratorResult<Record<string, unknown>>>>()
        .mockImplementationOnce(async () => ({ value: await pulled.promise, done: false }))
        .mockResolvedValue({ value: undefined, done: true })
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Inject only the SDK iterator/spawner; connection, delivery, translator, queue, journal and host exit are production.
      const queryImpl = ((params: Parameters<typeof query>[0]) => {
        params.options?.spawnClaudeCodeProcess?.({
          command: 'claude',
          args: [],
          env: {},
          signal: new AbortController().signal
        })
        return { [Symbol.asyncIterator]: () => ({ next }) }
      }) as unknown as typeof query
      const connection = await openClaudeStreamJsonConnection(
        { pathToClaudeCodeExecutable: 'claude', options: {}, cwd: '/work' },
        {
          onMessage: (frame) => {
            r.message(frame)
            return r.translator.whenDelivered?.()
          },
          onExit: () =>
            r.translator.handle({
              type: 'ended',
              sessionId: 'recovery',
              observedAt: Date.now(),
              reason: 'exit'
            })
        },
        () => child,
        queryImpl
      )
      const unbind = bindClaudeConnectionJournalControls(
        r.deferred.sink,
        connection,
        r.translator,
        {}
      )
      const dispose = vi.spyOn(r.translator, 'dispose')
      const gate = Promise.withResolvers<void>()
      await r.journal.readInOrder(() => {
        void r.journal.readInOrder(() => gate.promise)
      })
      for (const lifecycle of [false, true]) {
        r.deferred.sink.tryAppendItem?.(
          { provider: 'claude', sessionId: 'claude-session', uuid: String(lifecycle) },
          { kind: 'status', tone: 'info', text: 'blocked' },
          { turnScope: { kind: 'thread' }, lifecycle }
        )
      }
      const closing = connection.close()
      pulled.resolve({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: ' tail' }
        }
      })
      await vi.advanceTimersByTimeAsync(CLAUDE_READER_DRAIN_AFTER_EXIT_MS)
      await expect(closing).resolves.toBe(true)
      expect(dispose).not.toHaveBeenCalled()
      let record = agentSessionRecordFixture(
        agentSessionLeaseFixture({
          sessionId: 'recovery',
          runtimeKind: 'native',
          runtimeFence: 1,
          handoffStage: null,
          ownerProcess: {
            hostId: 'local',
            pid: 424242,
            processStartTimeMs: 1,
            spawnToken: 'spawn'
          },
          reservedSpawnToken: 'spawn',
          claimStatus: 'live',
          unreconciled: false
        })
      )
      const store = {
        getRecord: () => record,
        transitionHandoff: async (
          _id: string,
          transition: (current: typeof record) => typeof record
        ) => (record = transition(record))
      }
      const provider = { generation: 'generation', fence: 1, phase: 'ready' as const }
      const session: { child: typeof provider | null; journal: typeof r.journal } = {
        child: provider,
        journal: r.journal
      }
      const sessions = new Map([['recovery', session]])
      const discarded = vi.fn()
      const logger = { error: vi.fn(), warn: vi.fn() }
      const tail = endExitedStructuredAgentSessionChildUnderSerialize(
        {
          store,
          sessions,
          flushLifecycle: () => r.deferred.lifecycleBarrier(),
          generationEnded: vi.fn(),
          serialize: (_id, task) => task(),
          now: Date.now,
          logger,
          route: {
            runtimeState: { eventSinkFor: () => r.deferred, discardEventSink: discarded },
            acknowledgeRelease: vi.fn()
          }
        },
        'recovery',
        provider,
        { expected: true, reason: 'closed', observedAt: 60 }
      )
      await Promise.resolve()
      expect(record.lease.claimStatus).toBe('live')
      expect(discarded).not.toHaveBeenCalled()
      if (outcome === 'database-failure') {
        openTestJournalHostDatabase(r.root).db.exec(
          "CREATE TRIGGER pr35462_fail_output BEFORE INSERT ON journal_rows BEGIN SELECT RAISE(ABORT, 'unavailable'); END"
        )
      }
      gate.resolve()
      await vi.advanceTimersByTimeAsync(0)
      await tail
      expect(dispose).toHaveBeenCalledOnce()
      expect(session.child).toBeNull()
      expect(record.lease.claimStatus).toBe('released')
      expect(discarded).toHaveBeenCalledOnce()
      if (outcome === 'healthy') {
        const expected = {
          state: 'completed',
          completedAt: 60,
          blocks: [{ type: 'text', text: 'prefix tail' }]
        }
        expect(r.journal.itemBody('claude:claude-session:block%3Areply%3A0')).toMatchObject(
          expected
        )
        await r.journal.close()
        expect(
          (await r.reopen()).itemBody('claude:claude-session:block%3Areply%3A0')
        ).toMatchObject(expected)
      } else {
        expect(logger.warn).toHaveBeenCalled()
        await expect(r.deferred.sink.written?.()).resolves.toMatchObject({ ok: false })
      }
      expect(r.deferred.state().queuedBytes).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
      unbind?.()
    } finally {
      warn.mockRestore()
      await closeCheckpointTestJournals()
    }
  }
)
