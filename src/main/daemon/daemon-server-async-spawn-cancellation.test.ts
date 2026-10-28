import { registerDaemonCreationFailureTests } from './daemon-server-creation-failure.test-fixture'
import type * as LocalPtyUtils from '../providers/local-pty-utils'
import './mock-descendant-sweep'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DaemonClient } from './client'
import { createMockSubprocess } from './daemon-pty-adapter-test-harness'
import { DaemonServer } from './daemon-server'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import * as transport from './daemon-client-socket-connect'
import { HistoryManager } from './history-manager'
import type { DaemonClientConnections } from './daemon-client-connections'
import { getDaemonSocketPath } from './daemon-spawner'
import type { CancelCreateOrAttachResult, CreateOrAttachResult } from './types'
const nativePty = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node-pty', () => nativePty)

vi.mock('../providers/local-pty-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof LocalPtyUtils>()),
  ensureNodePtySpawnHelperExecutable: () => {},
  getNodePtySpawnHelperCandidates: () => [process.execPath]
}))
type DaemonServerInternals = {
  preparations: {
    pending: Map<string, Set<{ canceled: boolean }>>
  }
  host: { listSessions: () => unknown[] }
}

describe('daemon async spawn cancellation', () => {
  let directory: string
  let server: DaemonServer
  let client: DaemonClient
  let releaseSpawn: () => void
  let spawnStarted: Promise<void>
  let subprocess: ReturnType<typeof createMockSubprocess>
  let preparation: Promise<void>
  let spawned: number

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'daemon-async-spawn-cancel-'))
    let markSpawnStarted: () => void = () => {}
    spawnStarted = new Promise<void>((resolve) => {
      markSpawnStarted = resolve
    })
    const spawnGate = new Promise<void>((resolve) => {
      releaseSpawn = resolve
    })
    preparation = Promise.resolve()
    spawned = 0
    server = new DaemonServer({
      socketPath: getDaemonSocketPath(directory),
      tokenPath: join(directory, 'daemon.token'),
      preparePtySpawn: () => preparation,
      spawnSubprocess: async () => {
        spawned += 1
        subprocess = createMockSubprocess()
        markSpawnStarted()
        await spawnGate
        return subprocess
      }
    })
    await server.start()
    client = new DaemonClient({
      socketPath: getDaemonSocketPath(directory),
      tokenPath: join(directory, 'daemon.token')
    })
    await client.ensureConnected()
  })

  afterEach(async () => {
    releaseSpawn?.()
    client?.disconnect()
    await server?.shutdown()
    vi.restoreAllMocks()
    rmSync(directory, { recursive: true, force: true })
  })

  it.each([
    'healthy',
    'release-request-lost',
    'release-reply-lost',
    'late-recovery',
    'adoption-failed',
    'construction-failed',
    'continuing-adapter',
    'surviving-adapter',
    'replacement-endpoint'
  ] as const)(
    'consumes only after actual adoption and reclaims without a physical hold: %s',
    async (loss) => {
      const adapter = new DaemonPtyAdapter({
        socketPath: getDaemonSocketPath(directory),
        tokenPath: join(directory, 'daemon.token'),
        ...(loss === 'adoption-failed' ? { historyPath: join(directory, 'history') } : {})
      })
      if (loss === 'adoption-failed') {
        vi.spyOn(HistoryManager.prototype, 'openSession').mockRejectedValue(
          new Error('fixture disk unavailable')
        )
      }
      let successor: DaemonPtyAdapter | undefined
      let owner: { work: Promise<unknown>; recover: () => Promise<void> } | undefined
      let blocked = false
      let releaseSent = 0
      let releaseReplyDropped = false
      let originalReply: (() => void) | undefined
      let lateReply: (() => void) | undefined
      // SAFETY: inspect only this fixture's receiver and adapter ownership maps.
      const receiver = server as unknown as {
        preparations: { retained: Map<string, unknown> }
        connections: DaemonClientConnections
      }
      // SAFETY: read-only assertions on the actual local owners, never resolve/remove them from a test.
      const local = adapter as unknown as {
        switchReleaseCleanup: Map<string, unknown>
        switchReleaseDrain?: Promise<void>
        switchSpawnSettlements: Map<unknown, unknown>
      }
      const connect = transport.connectDaemonSocket
      vi.spyOn(transport, 'connectDaemonSocket').mockImplementation(async (...args) => {
        if (blocked) {
          throw new Error('Connection lost')
        }
        const socket = await connect(...args)
        const write = socket.write.bind(socket)
        vi.spyOn(socket, 'write').mockImplementation(
          (...values: Parameters<typeof socket.write>) => {
            const frame = JSON.parse(String(values[0]))
            if (frame.payload?.switchExecution?.phase === 'commit') {
              const peer = [...receiver.connections.values()].at(-1)?.controlSocket
              if (!peer) {
                throw new Error('fixture control missing')
              }
              const respond = peer.write.bind(peer)
              vi.spyOn(peer, 'write').mockImplementation(
                (...bytes: Parameters<typeof peer.write>) => {
                  const result = JSON.parse(String(bytes[0]))
                  if (loss === 'late-recovery' && result.id === frame.id) {
                    originalReply = () => {
                      respond(...bytes)
                    }
                    return true
                  }
                  if (loss === 'late-recovery' && result.payload?.settlement) {
                    lateReply = () => {
                      respond(...bytes)
                    }
                    return true
                  }
                  if (
                    loss === 'release-reply-lost' &&
                    !releaseReplyDropped &&
                    result.payload?.released === true
                  ) {
                    releaseReplyDropped = true
                    blocked = true
                    peer.destroy()
                    return true
                  }
                  return respond(...bytes)
                }
              )
            }
            if (frame.payload?.release) {
              releaseSent++
              if (releaseSent === 1 && frame.payload.release.outcome === 'adopted') {
                expect(adapter.getActiveSessionIds()).toContain('receipt-pane')
              }
              if (
                (loss === 'release-request-lost' ||
                  loss === 'continuing-adapter' ||
                  loss === 'surviving-adapter' ||
                  loss === 'replacement-endpoint') &&
                releaseSent === 1
              ) {
                blocked = true
                socket.destroy()
                return true
              }
            }
            return write(...values)
          }
        )
        return socket
      })
      const starting = adapter.spawn({
        sessionId: 'receipt-pane',
        cols: 80,
        rows: 24,
        switchExecution: {
          invocationId: 'adoption-click',
          signal: new AbortController().signal,
          remaining: () => 60_000,
          check: () => {},
          trackPhysical: (work, recover) => {
            if (recover) {
              owner = { work, recover }
            }
            return work
          }
        }
      })
      const observed = starting.then(
        (result) => ({ result }),
        (error: unknown) => ({ error })
      )
      try {
        await spawnStarted
        if (loss === 'construction-failed') {
          subprocess.onData = () => {
            throw new Error('fixture subscription failed')
          }
          vi.mocked(subprocess.forceKill).mockImplementation(() => {
            throw new Error('fixture close unavailable')
          })
        }
        releaseSpawn()
        if (loss === 'late-recovery') {
          await vi.waitFor(() => expect(originalReply).toBeTypeOf('function'))
          if (!owner) {
            throw new Error('receiver completion was not tracked')
          }
          const recovering = owner.recover()
          await vi.waitFor(() => expect(lateReply).toBeTypeOf('function'))
          originalReply!()
          expect(await observed).toMatchObject({ result: { id: 'receipt-pane' } })
          await owner.work
          await vi.waitFor(() => expect(receiver.preparations.retained.size).toBe(0))
          // The real older owned response arrives after the exact receipt has been released.
          lateReply!()
          await expect(recovering).resolves.toBeUndefined()
        } else if (loss === 'adoption-failed' || loss === 'construction-failed') {
          expect(await observed).toMatchObject({
            error: {
              message:
                loss === 'adoption-failed'
                  ? 'fixture disk unavailable'
                  : 'fixture subscription failed'
            }
          })
          expect(releaseSent).toBe(0)
          expect(local.switchSpawnSettlements.size).toBe(1)
          expect(receiver.preparations.retained.size).toBe(1)
          await expect(adapter.settleSwitchWorkForReplacement()).rejects.toThrow(
            loss === 'adoption-failed'
              ? 'not confirmed physical completion'
              : 'fixture close unavailable'
          )
          expect(local.switchSpawnSettlements.size).toBe(1)
          if (loss === 'construction-failed') {
            vi.mocked(subprocess.forceKill).mockImplementation(() => {
              setTimeout(() => subprocess._simulateExit(137), 5)
            })
          } else {
            subprocess._simulateExit(0)
          }
          if (!owner) {
            throw new Error('receiver completion was not tracked')
          }
          await owner.recover()
          await owner.work
        } else {
          expect(await observed).toMatchObject({ result: { id: 'receipt-pane' } })
          if (!owner) {
            throw new Error('receiver completion was not tracked')
          }
          await owner.work
          expect(local.switchSpawnSettlements.size).toBe(0)
          if (loss !== 'healthy') {
            await vi.waitFor(() => expect(blocked).toBe(true))
            await vi.waitFor(() => expect(local.switchReleaseDrain).toBeUndefined())
            expect(local.switchReleaseCleanup.size).toBe(1)
            expect(receiver.preparations.retained.size).toBe(
              loss === 'release-request-lost' ||
                loss === 'continuing-adapter' ||
                loss === 'surviving-adapter' ||
                loss === 'replacement-endpoint'
                ? 1
                : 0
            )
            // Physical ownership is consumed even while exact GC delivery is unavailable.
            await expect(owner.recover()).resolves.toBeUndefined()
            if (
              loss === 'continuing-adapter' ||
              loss === 'surviving-adapter' ||
              loss === 'replacement-endpoint'
            ) {
              await adapter.settleSwitchWorkForReplacement()
              successor = new DaemonPtyAdapter({
                socketPath: getDaemonSocketPath(directory),
                tokenPath: join(directory, 'daemon.token')
              })
              if (loss === 'replacement-endpoint') {
                await server.shutdown()
                server = new DaemonServer({
                  socketPath: getDaemonSocketPath(directory),
                  tokenPath: join(directory, 'daemon.token'),
                  spawnSubprocess: () => {
                    throw new Error('GC must never create a process')
                  }
                })
                await server.start()
              }
              successor.inheritSwitchReleaseCleanup(adapter)
              if (loss !== 'surviving-adapter') {
                adapter.dispose()
              }
            }
            blocked = false
            await (successor ?? adapter).listProcesses()
          }
        }
        if (loss === 'replacement-endpoint') {
          if (!successor) {
            throw new Error('successor missing')
          }
          // SAFETY: actual successor transport/outcome maps, never mutate them.
          const replacement = server as unknown as {
            preparations: { retained: Map<string, unknown> }
            connections: DaemonClientConnections
          }
          const cleanup = successor as unknown as {
            switchReleaseCleanup: Map<string, unknown>
            switchReleaseDrain?: Promise<void>
          }
          await vi.waitFor(() => expect(cleanup.switchReleaseCleanup.size).toBe(0))
          await vi.waitFor(() => expect(cleanup.switchReleaseDrain).toBeUndefined())
          expect(replacement.preparations.retained.size).toBe(0)
          await vi.waitFor(() => expect(replacement.connections.size).toBe(1))
          await successor.listProcesses()
          await vi.waitFor(() => expect(replacement.connections.size).toBe(1))
          expect(await successor.requestIdleRetirement()).toMatchObject({ state: 'retiring' })
          return
        }
        await vi.waitFor(() => expect(receiver.preparations.retained.size).toBe(0))
        await vi.waitFor(() => expect(local.switchReleaseCleanup.size).toBe(0))
        if (loss !== 'adoption-failed' && loss !== 'construction-failed') {
          expect(server.host.listSessions()).toMatchObject([
            { sessionId: 'receipt-pane', isAlive: true }
          ])
          expect(subprocess.forceKill).not.toHaveBeenCalled()
        }
        expect(spawned).toBe(1)
        if (loss === 'surviving-adapter') {
          await vi.waitFor(() => expect(receiver.connections.size).toBe(3))
        }
        if (
          loss === 'release-request-lost' ||
          loss === 'release-reply-lost' ||
          loss === 'surviving-adapter' ||
          loss === 'continuing-adapter'
        ) {
          await (successor ?? adapter).spawn({
            sessionId: 'receipt-pane',
            cols: 80,
            rows: 24,
            attachOnly: true
          })
        }
        const exit = vi.fn()
        ;(successor ?? adapter).onExit(exit)
        subprocess._simulateExit(0)
        if (loss !== 'adoption-failed' && loss !== 'construction-failed') {
          await vi.waitFor(() => expect(exit).toHaveBeenCalledOnce())
        }
        expect(receiver.preparations.retained.size).toBe(0)
        if (loss === 'continuing-adapter' || loss === 'surviving-adapter') {
          if (!successor) {
            throw new Error('successor missing')
          }
          client.disconnect()
          if (loss === 'surviving-adapter') {
            await vi.waitFor(() => expect(receiver.connections.size).toBe(2))
            expect(await successor.requestIdleRetirement()).toMatchObject({ state: 'busy' })
            adapter.dispose()
          }
          await vi.waitFor(() => expect(receiver.connections.size).toBe(1))
          expect(await successor.requestIdleRetirement()).toMatchObject({ state: 'retiring' })
        }
      } finally {
        blocked = false
        releaseSpawn()
        originalReply?.()
        lateReply?.()
        await observed
        subprocess?._simulateExit(0)
        await owner?.recover().catch(() => {})
        await owner?.work
        successor?.dispose()
        adapter.dispose()
      }
    },
    15_000
  )

  it('keeps owed terminal proof through ordinary graceful retirement and releases only an exact completed disposition', async () => {
    const prepared = await client.request<{ anchor: string }>('createOrAttach', {
      sessionId: 'owed-pane',
      cols: 80,
      rows: 24,
      switchExecution: { phase: 'prepare', invocationId: 'owed-click' }
    })
    const release = {
      sessionId: 'owed-pane',
      requestId: 'not-committed',
      release: {
        invocationId: 'owed-click',
        anchor: prepared.anchor,
        endpoint: client.getDaemonIdentity()!,
        outcome: 'exited' as const
      }
    }
    expect(await client.request('cancelCreateOrAttach', release)).toMatchObject({
      released: false,
      canceled: false
    })
    expect(await client.request('shutdownIfIdle', undefined)).toMatchObject({ retiring: false })
    const settled = await client.request('cancelCreateOrAttach', {
      sessionId: 'owed-pane',
      requestId: 'not-committed',
      settlement: release.release
    })
    expect(settled).toMatchObject({ settlement: { outcome: 'exited' } })
    expect(await client.request('shutdownIfIdle', undefined)).toMatchObject({ retiring: false })
    expect(await client.request('cancelCreateOrAttach', release)).toMatchObject({
      released: true,
      canceled: false
    })
    expect(await client.request('cancelCreateOrAttach', release)).toMatchObject({ released: true })
    expect(
      await client.request('cancelCreateOrAttach', {
        sessionId: 'owed-pane',
        requestId: 'not-committed',
        settlement: release.release
      })
    ).toMatchObject({ settlement: { outcome: 'unknown' } })
    expect(await client.request('shutdownIfIdle', undefined)).toMatchObject({ retiring: true })
  })

  it.each([
    'canceled',
    'missing-budget',
    'zero-budget',
    'oversized-budget',
    'unsupported-contract'
  ] as const)('settles an exact refused commit with no admitted work: %s', async (refusal) => {
    const sessionId = 'refused-switch'
    const prepared = await client.request<{ anchor: string }>('createOrAttach', {
      sessionId,
      cols: 80,
      rows: 24,
      switchExecution: { phase: 'prepare', invocationId: 'original-click' }
    })
    if (refusal === 'canceled') {
      await client.request('cancelCreateOrAttach', { sessionId, requestId: prepared.anchor })
    }
    let requestId = ''
    await expect(
      client.request(
        'createOrAttach',
        {
          sessionId,
          cols: 80,
          rows: 24,
          switchExecution: {
            phase: 'commit',
            contract: refusal === 'unsupported-contract' ? undefined : 'creation-settlement-v1',
            invocationId: 'original-click',
            anchor: prepared.anchor,
            ...(refusal === 'missing-budget'
              ? {}
              : {
                  remainingMs:
                    refusal === 'zero-budget'
                      ? 0
                      : refusal === 'oversized-budget'
                        ? 720_001
                        : 60_000
                })
          }
        },
        30_000,
        undefined,
        (sent) => {
          requestId = sent
        }
      )
    ).rejects.toThrow('Attach canceled')
    const settlement = {
      sessionId,
      requestId,
      settlement: {
        invocationId: 'original-click',
        anchor: prepared.anchor,
        endpoint: client.getDaemonIdentity()!
      }
    }
    for (let repeat = 0; repeat < 2; repeat++) {
      await expect(client.request('cancelCreateOrAttach', settlement)).resolves.toMatchObject({
        settlement: { outcome: 'exited' }
      })
    }
    expect(spawned).toBe(0)
    expect(server.host.listSessions()).toEqual([])
    await expect(
      client.request('createOrAttach', {
        sessionId,
        cols: 80,
        rows: 24,
        switchExecution: {
          phase: 'commit',
          contract: 'creation-settlement-v1',
          invocationId: 'original-click',
          anchor: prepared.anchor,
          remainingMs: 60_000
        }
      })
    ).rejects.toThrow('Attach canceled')
  })

  it.each(['pre-host', 'exited', 'live-unknown', 'used', 'replaced'] as const)(
    'rejoins the exact admitted owner and preserves physical truth: %s',
    async (outcome) => {
      const preHost = Promise.withResolvers<void>()
      if (outcome === 'pre-host') {
        preparation = preHost.promise
      }
      const sessionId = 'retained-switch'
      const prepared = await client.request<{ anchor: string }>('createOrAttach', {
        sessionId,
        cols: 80,
        rows: 24,
        switchExecution: { phase: 'prepare', invocationId: 'original-click' }
      })
      const endpoint = client.getDaemonIdentity()!
      let requestId = ''
      const create = client
        .request<CreateOrAttachResult>(
          'createOrAttach',
          {
            sessionId,
            cols: 80,
            rows: 24,
            switchExecution: {
              phase: 'commit',
              contract: 'creation-settlement-v1',
              invocationId: 'original-click',
              anchor: prepared.anchor,
              remainingMs: 60_000
            }
          },
          30_000,
          undefined,
          (sent) => {
            requestId = sent
          }
        )
        .catch(() => undefined)
      const payload = {
        sessionId,
        get requestId() {
          return requestId
        },
        settlement: { invocationId: 'original-click', anchor: prepared.anchor, endpoint }
      }
      if (outcome !== 'pre-host') {
        await spawnStarted
      }
      await expect(
        client.request('cancelCreateOrAttach', {
          ...payload,
          settlement: {
            ...payload.settlement,
            endpoint: { ...endpoint, launchNonce: 'different-endpoint' }
          }
        })
      ).resolves.toMatchObject({ settlement: { outcome: 'unknown' } })
      await expect(
        client.request('cancelCreateOrAttach', {
          ...payload,
          settlement: { ...payload.settlement, invocationId: 'other-click' }
        })
      ).resolves.toMatchObject({ settlement: { outcome: 'unknown' } })

      try {
        if (outcome === 'used' || outcome === 'replaced') {
          releaseSpawn()
          const original = await create
          expect(original?.incarnationId).toBeDefined()
          if (outcome === 'replaced') {
            subprocess._simulateExit(0)
          }
          const other = new DaemonClient({
            socketPath: getDaemonSocketPath(directory),
            tokenPath: join(directory, 'daemon.token')
          })
          try {
            await other.ensureConnected()
            await expect(other.request('cancelCreateOrAttach', payload)).resolves.toMatchObject({
              settlement: { outcome: 'unknown' }
            })
            const current = await other.request<CreateOrAttachResult>('createOrAttach', {
              sessionId,
              cols: 80,
              rows: 24
            })
            const protectedChild = subprocess
            expect(await client.request('cancelCreateOrAttach', payload)).toMatchObject({
              settlement:
                outcome === 'used'
                  ? { outcome: 'owned', result: { incarnationId: original?.incarnationId } }
                  : { outcome: 'exited' }
            })
            expect(protectedChild.forceKill).not.toHaveBeenCalled()
            expect(server.host.listSessions()).toMatchObject([
              { incarnationId: current.incarnationId, isAlive: true }
            ])
          } finally {
            other.disconnect()
          }
        } else {
          if (outcome === 'live-unknown') {
            subprocess.forceKill.mockImplementation(() => {
              throw new Error('physical close unavailable')
            })
          }
          let settled = false
          const joined = client
            .request<CancelCreateOrAttachResult>('cancelCreateOrAttach', payload)
            .then((value) => {
              settled = true
              return value
            })
          void joined.catch(() => {})
          await (outcome === 'pre-host'
            ? create
            : vi.waitFor(() => {
                const daemon = server as unknown as DaemonServerInternals
                expect([...(daemon.preparations.pending.get(sessionId) ?? [])][0]?.canceled).toBe(
                  true
                )
              }))
          expect(settled).toBe(false)
          if (outcome === 'pre-host') {
            await create
            expect(settled).toBe(false)
            expect(server.host.listSessions()).toEqual([])
            preHost.resolve()
          } else {
            releaseSpawn()
          }
          expect(await joined).toMatchObject({
            settlement: { outcome: outcome === 'live-unknown' ? 'owned' : 'exited' }
          })
          if (outcome === 'live-unknown') {
            expect(server.host.listSessions()).toMatchObject([{ isAlive: true }])
            const observedExit = vi.fn()
            const unsubscribe = client.onEvent(observedExit)
            subprocess._simulateExit(137)
            await vi.waitFor(() =>
              expect(observedExit).toHaveBeenCalledWith(
                expect.objectContaining({ event: 'exit', sessionId })
              )
            )
            unsubscribe()
            await expect(client.request('cancelCreateOrAttach', payload)).resolves.toMatchObject({
              settlement: { outcome: 'exited' }
            })
          } else {
            expect(server.host.listSessions()).toEqual([])
          }
        }
      } finally {
        preHost.resolve()
        releaseSpawn()
        subprocess?._simulateExit(137)
        await create
      }
    },
    20_000
  )

  it.each(['cancelCreateOrAttach', 'kill'] as const)(
    'reaps a subprocess canceled by %s during async spawn',
    async (requestType) => {
      const create = client.request('createOrAttach', {
        sessionId: 'canceled-spawn',
        cols: 80,
        rows: 24
      })
      const canceled = expect(create).rejects.toThrow('Attach canceled for session canceled-spawn')
      await spawnStarted

      await (requestType === 'kill'
        ? client.request('kill', { sessionId: 'canceled-spawn', immediate: true })
        : client.request('cancelCreateOrAttach', { sessionId: 'canceled-spawn' }))
      releaseSpawn()
      await canceled

      expect(subprocess.forceKill).toHaveBeenCalledOnce()
      await expect(client.request('listSessions', undefined)).resolves.toEqual({ sessions: [] })
    }
  )

  it('reaps a subprocess after its requesting client disconnects', async () => {
    const create = client
      .request('createOrAttach', {
        sessionId: 'disconnected-spawn',
        cols: 80,
        rows: 24
      })
      .catch(() => undefined)
    await spawnStarted

    client.disconnect()
    const daemon = server as unknown as DaemonServerInternals
    await vi.waitFor(() =>
      expect([...(daemon.preparations.pending.get('disconnected-spawn') ?? [])][0]?.canceled).toBe(
        true
      )
    )
    releaseSpawn()
    await create
    await vi.waitFor(() => expect(subprocess.forceKill).toHaveBeenCalledOnce())
    expect(daemon.host.listSessions()).toEqual([])
  })

  it('reaps a subprocess after the client request times out', async () => {
    const create = client.request(
      'createOrAttach',
      { sessionId: 'timed-out-spawn', cols: 80, rows: 24 },
      10
    )
    await spawnStarted

    await expect(create).rejects.toThrow('timed out')
    releaseSpawn()

    await vi.waitFor(() => expect(subprocess.forceKill).toHaveBeenCalledOnce())
    await expect(client.request('listSessions', undefined)).resolves.toEqual({ sessions: [] })
  })

  it('reaps a subprocess after the client aborts its request', async () => {
    const abort = new AbortController()
    const create = client.request(
      'createOrAttach',
      { sessionId: 'aborted-spawn', cols: 80, rows: 24 },
      30_000,
      abort.signal
    )
    await spawnStarted

    abort.abort()
    await expect(create).rejects.toThrow('client_disconnected')
    releaseSpawn()

    await vi.waitFor(() => expect(subprocess.forceKill).toHaveBeenCalledOnce())
    await expect(client.request('listSessions', undefined)).resolves.toEqual({ sessions: [] })
  })

  it('reaps an async spawn before daemon shutdown completes', async () => {
    const create = client
      .request('createOrAttach', {
        sessionId: 'shutdown-spawn',
        cols: 80,
        rows: 24
      })
      .catch(() => undefined)
    await spawnStarted

    const shutdown = server.shutdown()
    releaseSpawn()
    await create
    await shutdown

    expect(subprocess.forceKill).toHaveBeenCalledOnce()
    expect(subprocess.dispose).toHaveBeenCalledOnce()
  })
  registerDaemonCreationFailureTests({
    get directory() {
      return directory
    },
    get server() {
      return server
    },
    set server(value) {
      server = value
    },
    get client() {
      return client
    },
    get subprocess() {
      return subprocess
    },
    get releaseSpawn() {
      return releaseSpawn
    },
    get spawnStarted() {
      return spawnStarted
    },
    get spawned() {
      return spawned
    },
    get nativePty() {
      return nativePty
    }
  })
})
