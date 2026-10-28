import { registerDaemonNativeFailureTests } from './daemon-server-native-failure.test-fixture'
import './mock-descendant-sweep'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { DaemonClient } from './client'
import type { createMockSubprocess } from './daemon-pty-adapter-test-harness'
import type { DaemonServer } from './daemon-server'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import * as transport from './daemon-client-socket-connect'
import type { DaemonClientConnections } from './daemon-client-connections'
import { getDaemonSocketPath } from './daemon-spawner'
type DaemonServerInternals = {
  preparations: { pending: Map<string, Set<{ canceled: boolean }>> }
}
export type DaemonCreationFailureFixture = {
  directory: string
  server: DaemonServer
  client: DaemonClient
  subprocess: ReturnType<typeof createMockSubprocess>
  releaseSpawn: () => void
  spawnStarted: Promise<void>
  spawned: number
  nativePty: { spawn: ReturnType<typeof vi.fn> }
}
export function registerDaemonCreationFailureTests(fixture: DaemonCreationFailureFixture) {
  registerDaemonNativeFailureTests(fixture)
  it.each([
    ['constructor', 'retry'],
    ['publication', 'disposal']
  ] as const)(
    'ordinary authenticated create drives failed unpublished cleanup: %s/%s',
    async (failure, wake) => {
      const options = {
        sessionId: 'ordinary-failed',
        cols: 80,
        rows: 24,
        agentSessionEnsure: {
          claim: {
            digestVersion: 1 as const,
            keyId: 'key',
            identityDigest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            worktreeScopeDigest: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            agent: 'codex' as const
          },
          surface: {
            worktreeId: 'worktree',
            tabId: 'ordinary-tab',
            leafId: '11111111-1111-4111-8111-111111111111',
            terminalHandle: 'term_ordinary'
          }
        }
      }
      const creating = fixture.client.request('createOrAttach', options)
      const observed = expect(creating).rejects.toThrow('fixture subscription failed')
      await fixture.spawnStarted
      const failed = fixture.subprocess
      if (failure === 'constructor') {
        failed.onData = () => {
          throw new Error('fixture subscription failed')
        }
      } else {
        Object.assign(failed, {
          onInputClosed: () => {
            throw new Error('fixture subscription failed')
          }
        })
      }
      vi.mocked(failed.forceKill).mockImplementation(() => {
        throw new Error('fixture close unavailable')
      })
      fixture.releaseSpawn()
      await observed
      await vi.waitFor(() => expect(failed.forceKill).toHaveBeenCalled())
      expect(fixture.server.host.listSessions()).toEqual([])
      expect(fixture.server.automaticWork.gate.snapshot().terminals).toBe(1)
      const attempts = vi.mocked(failed.forceKill).mock.calls.length
      // The ordinary next authenticated request drives the retained resource, not a test callback.
      vi.mocked(failed.forceKill).mockImplementation(() => {
        setTimeout(() => failed._simulateExit(137), 5)
      })
      if (wake === 'disposal') {
        await fixture.server.host.dispose()
        expect(failed.dispose).toHaveBeenCalledOnce()
        expect(fixture.spawned).toBe(1)
        expect(fixture.server.automaticWork.gate.snapshot().terminals).toBe(0)
        return
      }
      expect(await fixture.client.request('createOrAttach', options)).toMatchObject({ isNew: true })
      expect(vi.mocked(failed.forceKill).mock.calls.length).toBeGreaterThan(attempts)
      expect(failed.dispose).toHaveBeenCalledOnce()
      expect(fixture.spawned).toBe(2)
      expect(fixture.server.automaticWork.gate.snapshot().terminals).toBe(1)
      await fixture.client.request('write', { sessionId: options.sessionId, data: 'new input' })
      expect(fixture.subprocess.write).toHaveBeenCalledWith('new input')
      await fixture.server.host.dispose()
      expect(fixture.server.automaticWork.gate.snapshot().terminals).toBe(0)
    }
  )

  it.each(['authority', 'canceled-before-send'] as const)(
    'finishes a known successful prepare when %s refuses before commit',
    async (failure) => {
      const adapter = new DaemonPtyAdapter({
        socketPath: getDaemonSocketPath(fixture.directory),
        tokenPath: join(fixture.directory, 'daemon.token')
      })
      const abort = new AbortController()
      let checks = 0
      let owner: { work: Promise<unknown>; recover: () => Promise<void> } | undefined
      const frames: {
        type: string
        payload?: { switchExecution?: { phase: string }; settlement?: unknown; release?: unknown }
      }[] = []
      const connect = transport.connectDaemonSocket
      vi.spyOn(transport, 'connectDaemonSocket').mockImplementation(async (...args) => {
        const socket = await connect(...args)
        const write = socket.write.bind(socket)
        vi.spyOn(socket, 'write').mockImplementation(
          (...bytes: Parameters<typeof socket.write>) => {
            frames.push(JSON.parse(String(bytes[0])))
            return write(...bytes)
          }
        )
        return socket
      })
      try {
        await expect(
          adapter.spawn({
            sessionId: 'known-prepared',
            cols: 80,
            rows: 24,
            signal: abort.signal,
            switchExecution: {
              invocationId: 'abandoned-click',
              signal: abort.signal,
              remaining: () => 60_000,
              check: () => {
                if (++checks !== 2) {
                  return
                }
                if (failure === 'authority') {
                  throw new Error('fixture newer authority')
                }
                abort.abort()
              },
              trackPhysical: (work, recover) => {
                if (recover) {
                  owner = { work, recover }
                }
                return work
              }
            }
          })
        ).rejects.toThrow(failure === 'authority' ? 'fixture newer authority' : /abort|disconnect/i)
        if (!owner) {
          throw new Error('known preparation lost its ordinary owner')
        }
        await owner.work
        // SAFETY: inspect only this fixture receiver's actual outcome owner.
        const receiver = fixture.server as unknown as {
          preparations: { hasOwedOutcomes(): boolean }
          connections: DaemonClientConnections
        }
        await vi.waitFor(() => expect(receiver.preparations.hasOwedOutcomes()).toBe(false))
        expect(
          frames.filter((frame) => frame.payload?.switchExecution?.phase === 'prepare')
        ).toHaveLength(1)
        expect(
          frames.filter((frame) => frame.payload?.switchExecution?.phase === 'commit')
        ).toHaveLength(0)
        expect(frames.some((frame) => frame.payload?.settlement)).toBe(true)
        expect(frames.some((frame) => frame.payload?.release)).toBe(true)
        expect(fixture.spawned).toBe(0)
        await owner.recover()
        adapter.dispose()
        await vi.waitFor(() => expect(receiver.connections.size).toBe(1))
        expect(await fixture.client.request('shutdownIfIdle', undefined)).toMatchObject({
          retiring: true
        })
      } finally {
        adapter.dispose()
      }
    }
  )
  it('matches a cancel for an attach-only request queued behind a hung create', async () => {
    const create = fixture.client.request('createOrAttach', {
      sessionId: 'shared-session',
      cols: 80,
      rows: 24
    })
    await fixture.spawnStarted
    const abort = new AbortController()
    const attach = fixture.client.request(
      'createOrAttach',
      { sessionId: 'shared-session', cols: 80, rows: 24, attachOnly: true },
      30_000,
      abort.signal
    )
    const daemon = fixture.server as unknown as {
      preparations: { pending: Map<string, Set<{ canceled: boolean }>> }
    }
    // Attach-only preparations must remain registered so cancellation can find them.
    await vi.waitFor(() => expect(daemon.preparations.pending.get('shared-session')?.size).toBe(2))

    abort.abort()
    await expect(attach).rejects.toThrow('client_disconnected')

    fixture.releaseSpawn()
    await expect(create).resolves.toMatchObject({ isNew: true })
  })
  it('does not cancel a sibling request for the same session id', async () => {
    const first = fixture.client.request('createOrAttach', {
      sessionId: 'shared-session',
      cols: 80,
      rows: 24
    })
    const abort = new AbortController()
    const second = fixture.client.request(
      'createOrAttach',
      { sessionId: 'shared-session', cols: 80, rows: 24 },
      30_000,
      abort.signal
    )
    await fixture.spawnStarted
    const daemon = fixture.server as unknown as DaemonServerInternals
    await vi.waitFor(() => expect(daemon.preparations.pending.get('shared-session')?.size).toBe(2))

    abort.abort()
    await expect(second).rejects.toThrow('client_disconnected')
    fixture.releaseSpawn()

    await expect(first).resolves.toMatchObject({ isNew: true })
    expect(fixture.subprocess.forceKill).not.toHaveBeenCalled()
    await expect(fixture.client.request('listSessions', undefined)).resolves.toMatchObject({
      sessions: [expect.objectContaining({ sessionId: 'shared-session' })]
    })
  })
}
