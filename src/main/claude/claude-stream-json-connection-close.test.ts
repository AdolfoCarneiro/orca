import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import { openAgentSessionJournal } from '../native-chat/agent-session-journal/journal-store-factory'
import {
  closeTestJournalHostDatabase,
  openTestJournalHostDatabase
} from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { createDeferredStructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { testEventSinkLogging } from '../native-chat/agent-session-wire/structured-agent-session-logger-test-support'
import { createClaudeJournalTranslator } from './claude-structured-journal-translation'
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

  it('releases a pulled frame when provider exit is reported', async () => {
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
    await vi.waitFor(() => expect(events).toEqual(['message:task_notification']))

    child.emit('exit', 1, null)
    await vi.waitFor(() => expect(events).toEqual(['message:task_notification', 'exit']))
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
      expect(warn).toHaveBeenCalledWith(
        '[claude-stream-json] output still open after the proven exit:',
        expect.anything()
      )
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

    await vi.waitFor(() => expect(exits).toEqual([true]))
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

it.each(['root-exit', 'requested-close'] as const)(
  'saves a resolved SDK next exactly once before %s retires its translator',
  async (ending) => {
    mocks.refresh.mockReset().mockResolvedValue(undefined)
    mocks.proveClaudeChildExit.mockReset().mockResolvedValue(true)
    const child = fakeChild()
    const pulled = Promise.withResolvers<IteratorResult<Record<string, unknown>>>()
    const next = vi
      .fn<() => Promise<IteratorResult<Record<string, unknown>>>>()
      .mockReturnValueOnce(pulled.promise)
      .mockResolvedValue({ done: true, value: undefined })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this query supplies exactly the spawn and iterator protocol exercised by the production reader.
    const queryImpl = ((params: Parameters<typeof query>[0]) => {
      params.options?.spawnClaudeCodeProcess?.({
        command: 'claude',
        args: [],
        env: {},
        signal: new AbortController().signal
      })
      return { [Symbol.asyncIterator]: () => ({ next }) }
    }) as unknown as typeof query
    const root = await mkdtemp(join(tmpdir(), 'orca-received-sdk-tail-'))
    const identity = {
      sessionId: 'session-1',
      workspaceId: 'workspace',
      hostId: 'host',
      agent: 'claude' as const,
      providerHandle: claudeProviderHandle('provider-session')
    }
    let journal = await openAgentSessionJournal({
      identity,
      database: openTestJournalHostDatabase(root)
    })
    const sink = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
    sink.bind({ journal, fence: 1, publish: () => {} })
    const translator = createClaudeJournalTranslator({ sink: sink.sink })
    const delivered: string[] = []
    let connection: Awaited<ReturnType<typeof openClaudeStreamJsonConnection>> | undefined
    try {
      connection = await openClaudeStreamJsonConnection(
        { pathToClaudeCodeExecutable: 'claude', options: {}, cwd: '/work/repo' },
        {
          onMessage: (message) => {
            delivered.push('message')
            translator.handle({ type: 'message', sessionId: 'session-1', message })
          },
          onExit: () => {
            delivered.push('exit')
            translator.handle({
              type: 'ended',
              sessionId: 'session-1',
              reason: 'exit',
              observedAt: 2
            })
            translator.dispose()
          }
        },
        () => child,
        queryImpl
      )
      expect(next).toHaveBeenCalledOnce()
      connection.pauseReading?.()
      // Resolve the actual next() promise, then exit in the same stack before its await runs.
      pulled.resolve({
        done: false,
        value: {
          type: 'user',
          session_id: 'provider-session',
          uuid: 'resolved-result',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'resolved-tool',
                content: 'the complete received tool result'
              }
            ]
          }
        }
      })
      const closing = ending === 'requested-close' ? connection.close() : undefined
      child.emit('exit', 0, null)
      connection.pauseReading?.()
      await vi.waitFor(() => expect(delivered).toEqual(['message', 'exit']))
      if (closing) {
        await closing
      }
      await expect(sink.drained()).resolves.toEqual({ ok: true })
      await journal.close()
      closeTestJournalHostDatabase(root)
      journal = await openAgentSessionJournal({
        identity,
        database: openTestJournalHostDatabase(root)
      })
      const tools = journal.snapshot().items.filter((item) => item.body.kind === 'tool-call')
      expect(tools).toHaveLength(1)
      expect(JSON.stringify(tools[0].body)).toContain('the complete received tool result')
    } finally {
      await connection?.close()
      translator.dispose()
      sink.close()
      await journal.close()
      closeTestJournalHostDatabase(root)
      await rm(root, { recursive: true, force: true })
    }
  }
)
