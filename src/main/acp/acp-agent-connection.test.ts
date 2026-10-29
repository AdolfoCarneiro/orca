import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PipedProcessSpawner } from '@orca/process-host/process-spec'
import { createFakePipedChild } from '../../shared/__fixtures__/fake-spawned-child'
import { PROVIDER_SUPERVISOR_MAX_STOP_MS } from '../provider-process/provider-process-supervisor'
import { ROOT_ONLY_GRACEFUL_EXIT_MS } from '../provider-process/provider-process-close'
import type { terminateProviderProcessTree } from '../provider-process/provider-process-teardown'
import {
  createAcpAgentConnection,
  type AcpAgentConnection,
  type AcpAgentConnectionOptions
} from './acp-agent-connection'
import { AcpAuthRequiredError } from './acp-errors'
import { AcpScriptedAgent, deferred, tick } from './acp-scripted-agent.test-support'

const teardown = vi.hoisted(() =>
  vi.fn<typeof terminateProviderProcessTree>(async () => 'unverifiable')
)
vi.mock('../provider-process/provider-process-teardown', () => ({
  terminateProviderProcessTree: teardown
}))

const opened: { connection: AcpAgentConnection; exit: () => void }[] = []
const grace =
  process.platform === 'win32' ? ROOT_ONLY_GRACEFUL_EXIT_MS : PROVIDER_SUPERVISOR_MAX_STOP_MS
const start = { cwd: '/execution-host/folder', mcpServers: [] }
const prompt = [{ type: 'text', text: 'hello' }] as const

function fixture(
  options: AcpAgentConnectionOptions = {},
  behavior: { pid?: number | null; exitOnEnd?: boolean } = {}
) {
  const agent = new AcpScriptedAgent()
  const child = Object.assign(createFakePipedChild(), {
    pid: behavior.pid === null ? undefined : (behavior.pid ?? 9_999_999),
    stdout: agent.stdout,
    stdin: agent.stdin,
    stderr: new PassThrough(),
    kill: vi.fn(() => true)
  })
  const spawn = vi.fn<PipedProcessSpawner>(() => {
    return child
  })
  agent.on('initialize', (frame) => agent.reply(frame, { protocolVersion: 1 }))
  agent.on('session/new', (frame) => agent.reply(frame, { sessionId: 'session-1' }))
  if (behavior.exitOnEnd !== false) {
    child.stdin.once('finish', () => {
      child.emit('exit', 0, null)
      child.stdout.end()
    })
  }
  const connection = createAcpAgentConnection(
    {
      command: 'fixture-acp-agent',
      args: ['--acp'],
      cwd: start.cwd,
      env: { ACP_ACCOUNT_HOME: '/host/account', STRIPPED: 'overlay' },
      envToDelete: ['STRIPPED']
    },
    options,
    spawn
  )
  opened.push({
    connection,
    exit: () => {
      child.emit('exit', 0, null)
      child.stdout.end()
    }
  })
  return { agent, child, spawn, connection }
}

afterEach(async () => {
  vi.useRealTimers()
  for (const { connection, exit } of opened.splice(0)) {
    exit()
    await connection.close()
  }
  teardown.mockReset().mockResolvedValue('unverifiable')
  vi.useRealTimers()
})

describe('ACP process-owning connection', () => {
  it('spawns through the supervisor with the host launch and exposes typed session calls', async () => {
    const { connection, spawn, child, agent } = fixture()
    await connection.spawned
    expect(connection.pid).toBe(child.pid)
    expect(connection.rootVerdict).toBe('live')
    expect(connection.lastCloseResult).toBeNull()
    expect(spawn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        cwd: start.cwd,
        env: expect.objectContaining({ ACP_ACCOUNT_HOME: '/host/account' }),
        stdio: ['pipe', 'pipe', 'pipe', ...(process.platform === 'win32' ? [] : ['ipc'])]
      })
    )
    expect(spawn.mock.calls[0][0].env).not.toHaveProperty('STRIPPED')
    expect(await connection.start(start)).toMatchObject({
      sessionId: 'session-1'
    })
    agent.on('session/prompt', (frame) => agent.reply(frame, { stopReason: 'end_turn' }))
    expect(await connection.prompt([...prompt])).toEqual({
      stopReason: 'end_turn'
    })
    connection.pauseReading()
    expect(child.stdout.isPaused()).toBe(true)
    connection.resumeReading()
    expect(child.stdout.isPaused()).toBe(false)
    expect(await connection.close()).toBe(true)
    expect(connection.lastCloseResult).toEqual({ root: 'exited', tree: null })
  })

  it('settles prompts and permission signals on proven exit with stdout still open', async () => {
    const statusDuringExit: unknown[] = []
    const onExit = vi.fn(() => statusDuringExit.push(connection.exitStatus))
    const onClose = vi.fn()
    const permission = deferred<AbortSignal>()
    const { connection, child, agent } = fixture({
      onExit,
      onClose,
      onPermission: (_request, context) => {
        permission.resolve(context.signal)
        return new Promise(() => {})
      }
    })
    await connection.start(start)
    const rejected = expect(connection.prompt([...prompt])).rejects.toThrow('provider failed')
    void agent.request('approval', 'session/request_permission', {
      sessionId: 'session-1',
      toolCall: { toolCallId: 'tool-1' },
      options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow' }]
    })
    const signal = await permission.promise
    child.stderr.write('provider failed\n')
    child.emit('exit', 7, null)
    child.emit('close', 7, null)
    await rejected
    expect(signal.aborted).toBe(true)
    expect(child.stdout.readableEnded).toBe(false)
    expect(connection.exited).toBe(true)
    expect(onClose).not.toHaveBeenCalled()
    expect(onExit).toHaveBeenCalledExactlyOnceWith(expect.any(Error), {
      expected: false,
      exit: { code: 7, signal: null, processless: false },
      inputDone: expect.any(Promise)
    })
    expect(statusDuringExit).toEqual([{ code: 7, signal: null, processless: false }])
    const late = vi.fn()
    connection.onExit(late)
    expect(late).toHaveBeenCalledOnce()
    await expect(connection.close()).resolves.toBe(true)
  })

  it('ends a turn signed out at a sign-in prompt line and never retains its URL', async () => {
    const said: string[] = []
    const onExit = vi.fn((error: Error) => said.push(error.message))
    const { connection, child } = fixture({
      onExit,
      onDiagnostic: (message) => said.push(message),
      signIn: {
        read: (line) =>
          line.startsWith('Open the following link to authenticate') ? 'link' : undefined
      }
    })
    await connection.start(start)
    const turn = connection.prompt([...prompt]).catch((error: unknown) => error)
    child.stderr.write(
      `warming up\nOpen the following link to authenticate the ACP server: https://accounts.example/auth?state=${'x'.repeat(8192)}`
    )
    child.stderr.write('s3cret\n')
    const error = await turn
    expect(error).toBeInstanceOf(AcpAuthRequiredError)
    await vi.waitFor(() => expect(onExit).toHaveBeenCalledOnce())
    said.push(String(error), connection.stderrTail())
    expect(connection.stderrTail()).toBe('warming up')
    expect(said.join('\n')).not.toMatch(/s3cret|accounts\.example/)
  })

  it('drops an overlong stderr line it could not classify instead of keeping its prefix', async () => {
    const { connection, child } = fixture({
      signIn: {
        read: (line) => (line.endsWith('authenticate') ? 'link' : undefined)
      }
    })
    await connection.start(start)
    const link = `https://accounts.example/auth?state=${'x'.repeat(33_000)}`
    child.stderr.write(`warming up\nplease visit ${link}`)
    child.stderr.write('s3cret\nready\n')
    await vi.waitFor(() => expect(connection.stderrTail()).toContain('ready'))
    expect(connection.stderrTail()).toBe('warming up\nready')
  })

  it('keeps cancel writable after stdout EOF and waits for process exit evidence', async () => {
    const onClose = vi.fn()
    const onExit = vi.fn()
    const { connection, child, agent } = fixture({ onClose, onExit })
    await connection.start(start)
    const rejected = expect(connection.prompt([...prompt])).rejects.toThrow('exited')
    child.stdout.end()
    await tick()
    expect(connection.closed).toBe(false)
    expect(connection.rootVerdict).toBe('live')
    await connection.cancel()
    expect(agent.frames.at(-1)?.method).toBe('session/cancel')
    expect(onClose).not.toHaveBeenCalled()
    expect(onExit).not.toHaveBeenCalled()
    expect(await connection.close()).toBe(true)
    await rejected
    expect(onExit.mock.calls[0][1].expected).toBe(true)
  })

  it('reports broken stdin immediately but reports exit only after the host observes it', async () => {
    vi.useFakeTimers()
    const onClose = vi.fn()
    const onExit = vi.fn()
    const { connection, child } = fixture({ onClose, onExit }, { exitOnEnd: false })
    await connection.start(start)
    const rejected = expect(connection.prompt([...prompt])).rejects.toThrow('broken pipe')
    child.stdin.emit('error', new Error('broken pipe'))
    child.emit('close', 0, null)
    await rejected
    expect(connection.closed).toBe(true)
    expect(connection.rootVerdict).toBe('live')
    expect(onClose).toHaveBeenCalledOnce()
    expect(onExit).not.toHaveBeenCalled()
    child.emit('exit', 1, null)
    await vi.advanceTimersByTimeAsync(0)
    expect(connection.rootVerdict).toBe('exited')
    expect(onExit.mock.calls[0][1].expected).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('joins physical close and retries unproven exit without spawning a replacement', async () => {
    vi.useFakeTimers()
    const onExit = vi.fn()
    const { connection, child, spawn } = fixture({ onExit }, { exitOnEnd: false })
    const first = connection.close()
    const joined = connection.close()
    await vi.advanceTimersByTimeAsync(grace + 2_000)
    expect(await first).toBe(false)
    expect(await joined).toBe(false)
    expect(connection.rootVerdict).toBe('live')
    expect(teardown).toHaveBeenCalledOnce()
    teardown.mockImplementationOnce(async () => {
      child.emit('exit', null, 'SIGKILL')
      return 'unverifiable'
    })
    const retry = connection.close()
    await vi.advanceTimersByTimeAsync(grace + 2_000)
    expect(await retry).toBe(true)
    expect(connection.processTreeUnproven).toBe(true)
    expect(spawn).toHaveBeenCalledOnce()
    expect(onExit.mock.calls[0][1].expected).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ends notification draining at the bounded close result even when exit remains unproven', async () => {
    vi.useFakeTimers()
    const onExtensionNotification = vi.fn()
    const { connection, agent } = fixture({ onExtensionNotification }, { exitOnEnd: false })
    await connection.start(start)
    const closing = connection.close()
    expect(connection.closed).toBe(true)
    agent.notify('_x.ai/session/update', { outcome: 'before-exit' })
    expect(onExtensionNotification).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(grace + 2_000)
    expect(await closing).toBe(false)
    expect(connection.rootVerdict).toBe('live')
    agent.notify('_x.ai/session/update', { outcome: 'after-unproven-close' })
    expect(onExtensionNotification).toHaveBeenCalledOnce()
    expect(agent.stdout.listenerCount('data')).toBe(0)
  })

  it.each(['live', 'unverifiable'] as const)(
    'retains %s tree evidence when root exits between completed close attempts',
    async (tree) => {
      vi.useFakeTimers()
      const { connection, child } = fixture({}, { exitOnEnd: false })
      teardown.mockResolvedValueOnce(tree)
      const close = connection.close()
      await vi.advanceTimersByTimeAsync(grace + 2_000)
      expect(await close).toBe(false)
      child.emit('exit', null, 'SIGKILL')
      expect(connection.processTreeUnproven).toBe(true)
      const finishing = connection.close()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(await finishing).toBe(true)
      expect(connection.processTreeUnproven).toBe(true)
      expect(connection.lastCloseResult).toEqual({ root: 'live', tree })
      expect(teardown).toHaveBeenCalledOnce()
    }
  )

  it('isolates early and late exit subscribers and continues delivering exit', () => {
    const onDiagnostic = vi.fn(() => {
      throw new Error('diagnostic')
    })
    const { connection, child } = fixture({ onDiagnostic })
    const failing = (): void => {
      throw new Error('observer')
    }
    const early = vi.fn()
    connection.onExit(failing)
    connection.onExit(early)
    expect(() => child.emit('exit', 0, null)).not.toThrow()
    expect(early).toHaveBeenCalledExactlyOnceWith({
      code: 0,
      signal: null,
      processless: false
    })
    expect(() => connection.onExit(failing)).not.toThrow()
    const late = vi.fn()
    connection.onExit(late)
    expect(late).toHaveBeenCalledOnce()
    expect(onDiagnostic).toHaveBeenCalledTimes(2)
  })

  it('settles a failed spawn but requires processless close evidence before reporting exit', async () => {
    const onExit = vi.fn()
    const { connection, child, agent } = fixture({ onExit }, { pid: null, exitOnEnd: false })
    agent.on('initialize', () => {})
    const rejected = expect(connection.initialize()).rejects.toThrow('ENOENT')
    child.emit('error', new Error('ENOENT'))
    await connection.spawned
    await rejected
    expect(connection.rootVerdict).toBe('unverifiable')
    expect(onExit).not.toHaveBeenCalled()
    child.emit('close', null, null)
    expect(connection.rootVerdict).toBe('exited')
    expect(onExit.mock.calls[0][1].exit.processless).toBe(true)
    expect(await connection.close()).toBe(true)
  })

  it('owns stderr failure cleanup and isolates failing exit callbacks', async () => {
    const { connection, child } = fixture({
      onExit: () => {
        throw new Error('listener')
      }
    })
    await connection.start(start)
    const rejected = expect(connection.prompt([...prompt])).rejects.toThrow('stderr failure')
    child.stderr.destroy(new Error('stderr failure'))
    await rejected
    await tick()
    expect(connection.exited).toBe(true)
    expect(await connection.close()).toBe(true)
  })

  it('rejects invalid peer options before starting any process', () => {
    const spawn = vi.fn<PipedProcessSpawner>()
    expect(() =>
      createAcpAgentConnection(
        { command: 'fixture', args: [] },
        { peer: { maxPendingRequests: 0 } },
        spawn
      )
    ).toThrow('positive finite integers')
    expect(spawn).not.toHaveBeenCalled()
  })
})

it.each([true, false])(
  'settles a typed session response synchronously before the following stdout sign-in line (valid=%s)',
  async (valid) => {
    const answers: boolean[] = []
    const { connection, agent } = fixture({
      signIn: {
        read: (line) => (line.startsWith('SIGN IN') ? 'fixture-link' : undefined),
        answered: (answer) => answers.push(answer)
      }
    })
    agent.on('session/new', (frame) =>
      agent.stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: valid ? { sessionId: 'accepted-session' } : {} })}\nSIGN IN fixture-link\n`
      )
    )
    const result = await connection.start(start).catch((error: unknown) => error)
    expect(answers).toEqual(valid ? [true, false] : [false])
    if (valid) {
      expect(result).toMatchObject({ sessionId: 'accepted-session' })
    } else {
      expect(result).toBeInstanceOf(Error)
    }
    expect(connection.closed).toBe(true)
  }
)

it('closes a recognized stdout prompt over 16 MiB without inventing a signed-out answer', async () => {
  const answered = vi.fn()
  const { connection, agent } = fixture({
    signIn: {
      read: (line) => (line.startsWith('SIGN IN') ? 'prefix-only' : undefined),
      answered
    }
  })
  await connection.start(start)
  expect(answered).toHaveBeenCalledExactlyOnceWith(true)
  agent.stdout.write(`SIGN IN ${'x'.repeat(16 * 1024 * 1024)}\n`)
  await vi.waitFor(() => expect(connection.closed).toBe(true))
  expect(answered).toHaveBeenCalledTimes(1)
})

it.each(['root-exit', 'requested-close'] as const)(
  'persists the separate-chunk tool update and prompt response before %s settles its lane',
  async (ending) => {
    const { openAcpAdapterRig, sendHello, PROVIDER_SESSION, GROK_CONFIG_OPTIONS } =
      await import('./acp-structured-adapter.test-support')
    const { closeProviderTimelineRigs } =
      await import('../native-chat/agent-session-timeline/provider-timeline-assembler-test-support')
    const { readAgentJournalTurn } = await import('../../shared/agent-session-turn-record')
    const agent = new AcpScriptedAgent()
    const child = Object.assign(createFakePipedChild(), {
      pid: 9_999_999,
      stdin: agent.stdin,
      stdout: agent.stdout,
      stderr: new PassThrough(),
      kill: vi.fn(() => true)
    })
    agent.on('initialize', (frame) => agent.reply(frame, { protocolVersion: 1 }))
    agent.on('session/new', (frame) =>
      agent.reply(frame, { sessionId: PROVIDER_SESSION, configOptions: GROK_CONFIG_OPTIONS })
    )
    for (const method of ['_x.ai/subagent/cancel', '_x.ai/task/kill']) {
      agent.on(method, (frame) => agent.fail(frame, -32602, 'Invalid params', 'missing field'))
    }
    child.stdin.once('finish', () => child.emit('exit', 0, null))
    let connection: AcpAgentConnection | undefined
    const f = await openAcpAdapterRig({
      deps: {
        connect: (launch, handlers) => {
          connection = createAcpAgentConnection(launch, handlers, () => child)
          return connection
        }
      }
    })
    const writer = Promise.withResolvers<void>()
    try {
      await f.acquire()
      expect(f.openFailure()).toBeUndefined()
      await sendHello(f, 'received-prompt')
      const prompt = agent.frames.find((frame) => frame.method === 'session/prompt')
      if (!prompt || !connection) {
        throw new Error('production prompt was not dispatched')
      }
      agent.notify('session/update', {
        sessionId: PROVIDER_SESSION,
        _meta: { promptId: 'prompt:received-prompt' },
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'received-tool',
          title: 'echo complete',
          kind: 'execute',
          status: 'in_progress'
        }
      })
      void f.rig.journal.readInOrder(() => writer.promise)
      for (let index = 0; index < 512; index++) {
        f.rig.eventSink.appendItem(
          { provider: 'orca', clientMessageId: `pressure-${index}` },
          { kind: 'status', tone: 'info', text: 'queued' },
          { turnScope: { kind: 'thread' } }
        )
      }
      // Every subsequent stdout chunk is resident in Node while the writer remains held.
      agent.notify('session/update', {
        sessionId: PROVIDER_SESSION,
        _meta: { promptId: 'prompt:received-prompt' },
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'received-tool',
          status: 'completed',
          content: [
            { type: 'content', content: { type: 'text', text: 'the entire received tool output' } }
          ]
        }
      })
      agent.reply(prompt, { stopReason: 'end_turn' })
      expect(child.stdout.readableLength).toBeGreaterThan(0)
      const closing = ending === 'requested-close' ? connection.close() : undefined
      child.emit('exit', 0, null)
      expect(connection.exited).toBe(true)
      await expect(connection.prompt([{ type: 'text', text: 'too late' }])).rejects.toThrow()
      child.stdout.end()
      await (closing ?? connection.close())
      expect(agent.frames.filter((frame) => frame.method === 'session/prompt')).toHaveLength(1)
      expect(f.settled).toContainEqual(
        expect.objectContaining({
          clientMessageId: 'received-prompt',
          providerIdentity: expect.anything()
        })
      )
      writer.resolve()
      const reopened = await f.rig.reopenJournal()
      const rows = reopened.snapshot().items
      const tools = rows.filter((row) => row.body.kind === 'tool-call')
      expect(tools).toHaveLength(1)
      expect(tools[0].body).toMatchObject({
        state: 'completed',
        callId: 'received-tool',
        output: { head: 'the entire received tool output', truncated: false }
      })
      expect(rows.flatMap((row) => readAgentJournalTurn(row.body) ?? [])).toContainEqual(
        expect.objectContaining({ state: 'completed' })
      )
    } finally {
      writer.resolve()
      child.stdout.end()
      await connection?.close()
      await f.adapter.closeAll()
      await closeProviderTimelineRigs()
    }
  }
)

it('normalizes a received session/new identity and context before startup exit retires its lane', async () => {
  const { openAcpAdapterRig, PROVIDER_SESSION, GROK_CONFIG_OPTIONS } =
    await import('./acp-structured-adapter.test-support')
  const { SESSION, closeProviderTimelineRigs } =
    await import('../native-chat/agent-session-timeline/provider-timeline-assembler-test-support')
  const agent = new AcpScriptedAgent()
  const child = Object.assign(createFakePipedChild(), {
    pid: 9_999_999,
    stdin: agent.stdin,
    stdout: agent.stdout,
    stderr: new PassThrough(),
    kill: vi.fn(() => true)
  })
  agent.on('initialize', (frame) => agent.reply(frame, { protocolVersion: 1 }))
  const requested = deferred<Parameters<typeof agent.reply>[0]>()
  agent.on('session/new', (frame) => requested.resolve(frame))
  let connection: AcpAgentConnection | undefined
  const f = await openAcpAdapterRig({
    deps: {
      connect: (launch, handlers) => {
        connection = createAcpAgentConnection(launch, handlers, () => child)
        return connection
      }
    }
  })
  try {
    f.rig.assembler.apply({ type: 'turn.open', turn: 'previous-turn', at: 1_000 })
    f.rig.assembler.apply({ type: 'turn.end', at: 2_000, state: 'completed', outcome: 'success' })
    const acquired = await f.acquire({ waitForStart: false })
    const opening = f.adapter
      .open({
        sessionId: SESSION,
        fence: 1,
        acquisitionGeneration: acquired.acquisitionGeneration,
        signal: new AbortController().signal
      })
      .catch((error: unknown) => error)
    const request = await requested.promise
    if (!connection) {
      throw new Error('startup did not create its connection')
    }
    child.stdout.pause()
    agent.reply(request, {
      sessionId: PROVIDER_SESSION,
      configOptions: GROK_CONFIG_OPTIONS,
      models: {
        currentModelId: 'grok-4.7',
        availableModels: [
          { modelId: 'grok-4.7', name: 'Grok 4.7', _meta: { totalContextTokens: 200_000 } }
        ]
      }
    })
    child.emit('exit', 0, null)
    child.stdout.end()
    await connection.close()
    expect(await opening).toBeInstanceOf(Error)
    const reopened = await f.rig.reopenJournal()
    expect(reopened.contextUsage().window?.tokens).toBe(200_000)
  } finally {
    child.emit('exit', 0, null)
    child.stdout.end()
    await connection?.close()
    await f.adapter.closeAll()
    await closeProviderTimelineRigs()
  }
})
