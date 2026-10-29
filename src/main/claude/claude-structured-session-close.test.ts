import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkpointJournalRig, closeCheckpointTestJournals } from './claude-checkpoint-test-support'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type {
  ClaudeStructuredSessionAdapterDeps,
  ClaudeStructuredSessionEvent
} from './structured/claude-structured-session-state'
import {
  PROVIDER_SESSION_ID,
  adapterFor,
  fakeClaude,
  identityFor
} from './claude-structured-session-test-support'
import type { AgentChildWorkEvidence } from '../../shared/agent-status-child-work-evidence'
import { AgentSessionAcquisitionRootExitObservedError } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { ClaudePromptRegistry } from './claude-structured-prompt-replies'
import { claudeRootExitObserved, closeClaudeSession } from './claude-structured-session-close'
import { ClaudeAcquisitionRegistry } from './structured/claude-structured-session-state'

afterEach(closeCheckpointTestJournals)

it.each(['close', 'exit'] as const)(
  'delivers a pulled frame through the actual adapter after %s publication, before final cursor persistence',
  async (boundary) => {
    const r = await checkpointJournalRig()
    r.translator.dispose()
    const claude = fakeClaude()
    const persisted = vi.fn<NonNullable<ClaudeStructuredSessionAdapterDeps['persistHandle']>>()
    const adapter = adapterFor(claude, {}, [], [], undefined, persisted)
    await adapter.acquire({
      identity: identityFor(),
      fence: 7,
      spawnToken: 'spawn',
      events: r.deferred.sink
    })
    const connection = claude.connections[0]!
    const delivered = Promise.withResolvers<void>()
    connection.outputDrained = delivered.promise
    const stream = (event: Record<string, unknown>) =>
      connection.handlers.onMessage?.({
        type: 'stream_event',
        session_id: PROVIDER_SESSION_ID,
        uuid: 'stream',
        event
      })
    await stream({ type: 'message_start', message: { id: 'reply' } })
    await stream({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'prefix' }
    })
    const key = `claude:${PROVIDER_SESSION_ID}:block%3Areply%3A0`
    await vi.waitFor(() =>
      expect(r.journal.itemBody(key)).toMatchObject({ blocks: [{ type: 'text', text: 'prefix' }] })
    )
    if (boundary === 'close') {
      await expect(adapter.closeSession('session-1')).resolves.toBe(true)
    } else {
      connection.exitVerdict = { root: 'exited', tree: 'exited' }
      connection.handlers.onExit?.(new Error('exited'), { expected: false })
      await adapter.drainObservedExits()
    }
    expect(persisted).not.toHaveBeenCalled()
    await stream({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: ' tail' }
    })
    delivered.resolve()
    await r.deferred.outputDrained?.()
    await vi.waitFor(() => expect(persisted).toHaveBeenCalledOnce())
    expect(r.journal.itemBody(key)).toMatchObject({
      blocks: [{ type: 'text', text: 'prefix tail' }]
    })
    await r.journal.close()
    expect((await r.reopen()).itemBody(key)).toMatchObject({
      blocks: [{ type: 'text', text: 'prefix tail' }]
    })
  }
)

describe('Claude published session close lifecycle', () => {
  it('never reads a failed spawn as an observed root exit, whatever checks it first', async () => {
    const claude = fakeClaude()
    const adapter = adapterFor(claude)
    await adapter.acquire({ identity: identityFor(), fence: 7, spawnToken: 'spawn-9' })
    const connection = claude.connections[0]!
    connection.exitVerdict = { root: 'exited', tree: 'exited', processless: true }
    expect(claudeRootExitObserved(connection)).toBe(false)
    connection.exitVerdict = { root: 'exited', tree: 'unverifiable' }
    expect(claudeRootExitObserved(connection)).toBe(true)
  })

  it('reports a proven root exit when published-session close cannot prove descendants', async () => {
    const claude = fakeClaude()
    const adapter = adapterFor(claude)
    await adapter.acquire({ identity: identityFor(), fence: 7, spawnToken: 'spawn-9' })
    const connection = claude.connections[0]!
    connection.exitVerdict = { root: 'exited', tree: 'unverifiable' }
    connection.close = vi.fn<() => Promise<boolean>>().mockResolvedValue(false)

    await expect(adapter.closeSession('session-1')).rejects.toBeInstanceOf(
      AgentSessionAcquisitionRootExitObservedError
    )
  })

  it('lets the chat start again after a close that saw the root exit', async () => {
    const claude = fakeClaude()
    const adapter = adapterFor(claude)
    await adapter.acquire({ identity: identityFor(), fence: 7, spawnToken: 'spawn-9' })
    const first = claude.connections[0]!
    first.exitVerdict = { root: 'exited', tree: 'unverifiable' }
    first.close = vi.fn<() => Promise<boolean>>().mockResolvedValue(false)
    await expect(adapter.closeSession('session-1')).rejects.toBeInstanceOf(
      AgentSessionAcquisitionRootExitObservedError
    )

    await adapter.acquire({ identity: identityFor(), fence: 8, spawnToken: 'spawn-10' })

    expect(claude.connections).toHaveLength(2)
    expect(first.close).toHaveBeenCalledTimes(1)
  })

  it('starts the chat over a live session whose close saw the root exit', async () => {
    const claude = fakeClaude()
    const events: ClaudeStructuredSessionEvent[] = []
    const adapter = adapterFor(claude, {}, events)
    await adapter.acquire({ identity: identityFor(), fence: 7, spawnToken: 'spawn-9' })
    const first = claude.connections[0]!
    first.exitVerdict = { root: 'exited', tree: 'unverifiable' }
    first.close = vi.fn<() => Promise<boolean>>().mockResolvedValue(false)

    await adapter.acquire({ identity: identityFor(), fence: 8, spawnToken: 'spawn-10' })

    expect(claude.connections).toHaveLength(2)
    expect(events.filter((event) => event.type === 'ended')).toHaveLength(1)
  })

  it('reports the same root-exit verdict while cancelling acquisition', async () => {
    const claude = fakeClaude({
      unprovenCloseVerdict: { root: 'exited', tree: 'unverifiable' }
    })
    const acquisitions = new ClaudeAcquisitionRegistry()
    const { attempt } = acquisitions.start('session-1', new ClaudePromptRegistry())
    attempt.connection = await claude.openConnection({
      pathToClaudeCodeExecutable: 'claude',
      options: {},
      cwd: '/work/repo'
    })

    await expect(
      closeClaudeSession({ sessionId: 'session-1', sessions: new Map(), acquisitions })
    ).rejects.toBeInstanceOf(AgentSessionAcquisitionRootExitObservedError)
  })

  it('ends the session even when the durable handle write rejects', async () => {
    const claude = fakeClaude()
    const events: ClaudeStructuredSessionEvent[] = []
    const persistenceError = new Error('store unavailable')
    const persistHandle = vi
      .fn<NonNullable<ClaudeStructuredSessionAdapterDeps['persistHandle']>>()
      .mockRejectedValueOnce(persistenceError)
      .mockResolvedValueOnce(undefined)
    const childWork: AgentChildWorkEvidence['type'][] = []
    const adapter = adapterFor(
      claude,
      {},
      events,
      [],
      undefined,
      persistHandle,
      (_sessionId, evidence) => childWork.push(...evidence.map((edge) => edge.type))
    )
    const journalSink: StructuredAgentSessionEventSink = {
      appendItem: () => {},
      appendTombstone: () => {},
      publish: () => {}
    }
    await adapter.acquire({
      identity: identityFor(),
      fence: 7,
      spawnToken: 'spawn-9',
      events: journalSink
    })
    claude.connections[0]!.handlers.onMessage?.({
      type: 'system',
      subtype: 'task_started',
      session_id: PROVIDER_SESSION_ID,
      uuid: 'task-start',
      task_id: 'background-1',
      task_type: 'local_agent',
      is_backgrounded: true
    })
    expect(childWork).toEqual(['live'])
    const session = (
      adapter as unknown as {
        sessions: Map<string, { translator: { dispose: () => void } | null }>
      }
    ).sessions.get('session-1')
    const disposeTranslator = vi.spyOn(session!.translator!, 'dispose')

    await expect(adapter.closeSession('session-1')).resolves.toBe(true)
    await vi.waitFor(() => expect(persistHandle).toHaveBeenCalledOnce())
    expect(events.filter((event) => event.type === 'ended')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'handle')).toHaveLength(0)
    expect(disposeTranslator).toHaveBeenCalledOnce()
    // Session close cannot prove how unfinished child work ended.
    expect(childWork).toEqual(['live', 'session-ended'])

    await expect(adapter.closeSession('session-1')).resolves.toBe(true)
    expect(persistHandle).toHaveBeenCalledOnce()
    expect(events.filter((event) => event.type === 'ended')).toHaveLength(1)
    expect(disposeTranslator).toHaveBeenCalledOnce()
  })
})
