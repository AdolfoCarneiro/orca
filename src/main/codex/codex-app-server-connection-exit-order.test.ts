import { createCodexJournalTranslator } from './codex-structured-journal-translation'
import {
  openProviderTimelineRig,
  closeProviderTimelineRigs,
  SESSION
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
afterEach(closeProviderTimelineRigs)
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { spawnProcess } from '@orca/process-host'
import { openCodexAppServerConnection } from './codex-app-server-connection'

function stubChild() {
  const child = Object.assign(new EventEmitter(), {
    // Outside any real process table so teardown never mistakes an unrelated process for it.
    pid: 9_999_999,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true)
  })
  child.stdin.once('data', () => {
    child.stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`)
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The connection reads only events, pid, streams and kill from this stub.
  const spawnImpl = (() => child) as unknown as typeof spawnProcess
  return { child, spawnImpl }
}

describe('Codex app-server exit order', () => {
  it('reports an exit whose stdout ended first once the exit is seen, with its usual reason', async () => {
    const { child, spawnImpl } = stubChild()
    const exits: string[] = []
    const connection = await openCodexAppServerConnection(
      { command: 'codex', args: ['app-server'] },
      { onExit: (error) => exits.push(error.message) },
      spawnImpl
    )

    child.stderr.write('codex crashed\n')
    child.stdout.end()
    // Stream writes land a tick later, so the stderr tail is only complete here.
    await new Promise((resolve) => setImmediate(resolve))
    expect(exits).toEqual([])
    child.emit('exit', 1, null)
    child.emit('close', 1, null)

    expect(exits).toHaveLength(1)
    expect(exits[0]).toContain('codex crashed')
    await connection.close()
  })
})

it('transfers complete paused provider records before root exit retires the translator', async () => {
  const rig = await openProviderTimelineRig()
  const translator = createCodexJournalTranslator({
    sink: rig.eventSink,
    sessionId: SESSION,
    primaryThreadId: () => 'thread'
  })
  const { child, spawnImpl } = stubChild()
  const delivered: string[] = []
  const connection = await openCodexAppServerConnection(
    { command: 'codex', args: ['app-server'] },
    {
      onNotification: (method, params) => {
        delivered.push(method)
        translator.handle({
          type: 'notification',
          sessionId: SESSION,
          threadId: 'thread',
          method,
          params
        })
        connection.pauseReading?.()
      },
      onExit: () => {
        delivered.push('exit')
        translator.dispose()
      }
    },
    spawnImpl
  )
  try {
    child.stdout.write(
      [
        {
          method: 'item/started',
          params: {
            threadId: 'thread',
            turnId: 'turn',
            item: {
              id: 'tool',
              type: 'commandExecution',
              command: 'echo result',
              status: 'inProgress'
            }
          }
        },
        {
          method: 'item/completed',
          params: {
            threadId: 'thread',
            turnId: 'turn',
            item: {
              id: 'tool',
              type: 'commandExecution',
              command: 'echo result',
              status: 'completed',
              aggregatedOutput: 'complete paused result',
              exitCode: 0
            }
          }
        }
      ]
        .map((frame) => `${JSON.stringify(frame)}\n`)
        .join('')
    )
    expect(delivered).toEqual(['item/started'])
    child.emit('exit', 0, null)
    expect(delivered).toEqual(['item/started', 'item/completed', 'exit'])
    const reopened = await rig.reopenJournal()
    const tools = reopened.snapshot().items.filter((row) => row.body.kind === 'tool-call')
    expect(tools).toHaveLength(1)
    expect(JSON.stringify(tools[0].body)).toContain('complete paused result')
    await connection.close()
    expect(delivered).toHaveLength(3)
  } finally {
    await connection.close()
    translator.dispose()
  }
})
