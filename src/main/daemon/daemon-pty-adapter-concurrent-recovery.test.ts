import './mock-descendant-sweep'
import { expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonServer } from './daemon-server'
import { createMockSubprocess } from './daemon-pty-adapter-test-harness'
import { getDaemonSocketPath } from './daemon-spawner'
import type { DaemonClientConnections } from './daemon-client-connections'
import { agentSessionSwitchDeadline } from '../../shared/agent-session-switch-execution'

it('recovers concurrent spawns rejected by an adapter-initiated disconnect', async () => {
  const concurrentSpawnCount = 70
  const dir = mkdtempSync(join(tmpdir(), 'daemon-concurrent-recovery-test-'))
  const socketPath = getDaemonSocketPath(dir)
  const tokenPath = join(dir, 'test.token')
  const allPreparationsEntered = Promise.withResolvers<void>()
  const releaseHeldPreparations = Promise.withResolvers<void>()
  const spawnedSessionIds: string[] = []
  let preparationCount = 0

  const spawnSubprocess: ConstructorParameters<typeof DaemonServer>[0]['spawnSubprocess'] = (
    options
  ) => {
    spawnedSessionIds.push(options.sessionId)
    return createMockSubprocess()
  }
  let server = new DaemonServer({
    socketPath,
    tokenPath,
    spawnSubprocess,
    // Hold siblings until one retriable reply makes the adapter disconnect their shared socket.
    preparePtySpawn: async () => {
      const preparationNumber = ++preparationCount
      if (preparationCount === concurrentSpawnCount) {
        allPreparationsEntered.resolve()
      }
      await allPreparationsEntered.promise
      if (preparationNumber === 1) {
        throw new Error('Connection lost')
      }
      await releaseHeldPreparations.promise
    }
  })
  await server.start()

  const respawn = vi.fn(async () => {
    await server.shutdown()
    releaseHeldPreparations.resolve()
    server = new DaemonServer({ socketPath, tokenPath, spawnSubprocess })
    await server.start()
  })
  const adapter = new DaemonPtyAdapter({ socketPath, tokenPath, respawn })

  try {
    const sessionIds = Array.from(
      { length: concurrentSpawnCount },
      (_, index) => `high-volume-${index}`
    )
    const results = await Promise.all(
      sessionIds.map((sessionId) => adapter.spawn({ sessionId, cols: 80, rows: 24 }))
    )

    expect(preparationCount).toBe(concurrentSpawnCount)
    expect(respawn).toHaveBeenCalledTimes(1)
    expect(respawn).toHaveBeenCalledWith('daemon_died')
    expect(new Set(results.map(({ id }) => id))).toEqual(new Set(sessionIds))
    expect(new Set(spawnedSessionIds)).toEqual(new Set(sessionIds))

    const later = await adapter.spawn({ sessionId: 'after-recovery', cols: 80, rows: 24 })
    expect(later.id).toBe('after-recovery')
    expect(respawn).toHaveBeenCalledTimes(1)
    expect(spawnedSessionIds).toHaveLength(concurrentSpawnCount + 1)
  } finally {
    adapter.dispose()
    releaseHeldPreparations.resolve()
    await server.shutdown()
    rmSync(dir, { recursive: true, force: true })
  }
})

it.skipIf(process.platform === 'win32')(
  'keeps an exact dispatched owner unknown across an authenticated empty endpoint replacement',
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'daemon-switch-replacement-'))
    const socketPath = getDaemonSocketPath(directory)
    const tokenPath = join(directory, 'test.token')
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const child = createMockSubprocess()
    const originalSpawn = vi.fn(async () => {
      entered.resolve()
      await release.promise
      return child
    })
    const original = new DaemonServer({
      socketPath,
      tokenPath,
      launchNonce: 'original',
      preparePtySpawn: async () => {},
      spawnSubprocess: originalSpawn
    })
    await original.start()
    const adapter = new DaemonPtyAdapter({ socketPath, tokenPath })
    const deadline = agentSessionSwitchDeadline()
    let settled = false
    let recover: (() => Promise<void>) | undefined
    const operation = adapter
      .spawn({
        sessionId: 'exact-owner',
        cols: 80,
        rows: 24,
        signal: deadline.signal,
        switchExecution: {
          invocationId: 'original-click',
          ...deadline,
          trackPhysical: (work, recovery) => {
            recover = recovery
            void work.then(() => {
              settled = true
            })
            return work
          }
        }
      })
      .catch((error: unknown) => error)
    let replacement: DaemonServer | undefined
    try {
      await entered.promise
      // Replace only this fixture's POSIX socket; the original receiver and pending child remain alive.
      unlinkSync(socketPath)
      const replacementSpawn = vi.fn(() => createMockSubprocess())
      replacement = new DaemonServer({
        socketPath,
        tokenPath,
        launchNonce: 'replacement',
        spawnSubprocess: replacementSpawn
      })
      await replacement.start()
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this is the exact owned fixture server's authenticated connection registry.
      const connections = (original as unknown as { connections: DaemonClientConnections })
        .connections
      connections.values().next().value?.controlSocket.destroy()
      expect(await operation).toBeInstanceOf(Error)
      await vi.waitFor(() =>
        expect(adapter.getLastAuthenticatedDaemonIdentity()?.launchNonce).toBe('replacement')
      )
      expect(await adapter.listProcesses()).toEqual([])
      if (!recover) {
        throw new Error('dispatched settlement recovery missing')
      }
      await expect(recover()).rejects.toThrow('Terminal owner unavailable')
      expect(settled).toBe(false)
      expect(replacementSpawn).not.toHaveBeenCalled()
      expect(originalSpawn).toHaveBeenCalledOnce()
      release.resolve()
      await vi.waitFor(() => expect(child.forceKill).toHaveBeenCalled())
      // An empty new daemon still cannot answer for the old receiver's exact child.
      expect(settled).toBe(false)
    } finally {
      release.resolve()
      deadline.dispose()
      adapter.dispose()
      await operation
      await original.shutdown()
      await replacement?.shutdown()
      rmSync(directory, { recursive: true, force: true })
    }
  }
)
