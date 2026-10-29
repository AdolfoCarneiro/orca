import './mock-descendant-sweep'
import * as transport from './daemon-client-socket-connect'
import type { DaemonClientConnections } from './daemon-client-connections'
import { expect, it, vi } from 'vitest'
import { DaemonClient } from './client'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonServer } from './daemon-server'
import { agentSessionSwitchDeadline } from '../../shared/agent-session-switch-execution'
import { createMockSubprocess } from './daemon-pty-adapter-test-harness'
export function registerDaemonSwitchCompatibilityTests(fixture: {
  server: DaemonServer
  adapter: DaemonPtyAdapter
  socketPath: string
  tokenPath: string
}) {
  it('uses supported v53 ordinary creation before dispatch with existing source authority', async () => {
    fixture.adapter.dispose()
    await fixture.server.shutdown()
    const spawn = vi.fn(() => createMockSubprocess())
    fixture.server = new DaemonServer({
      socketPath: fixture.socketPath,
      tokenPath: fixture.tokenPath,
      protocolVersion: 53,
      spawnSubprocess: spawn
    })
    await fixture.server.start()
    fixture.adapter = new DaemonPtyAdapter({
      socketPath: fixture.socketPath,
      tokenPath: fixture.tokenPath,
      protocolVersion: 53
    })
    const request = vi.spyOn(DaemonClient.prototype, 'request')
    const deadline = agentSessionSwitchDeadline()
    try {
      expect(
        await fixture.adapter.spawn({ sessionId: 'legacy-ordinary', cols: 80, rows: 24 })
      ).toMatchObject({ id: 'legacy-ordinary' })
      await expect(
        fixture.adapter.spawn({
          sessionId: 'switch-destination',
          cols: 80,
          rows: 24,
          switchExecution: { invocationId: 'new-click', ...deadline }
        })
      ).resolves.toMatchObject({ id: 'switch-destination' })
      expect(spawn).toHaveBeenCalledTimes(2)
      const creates = request.mock.calls.filter(([type]) => type === 'createOrAttach')
      expect(creates).toHaveLength(2)
      for (const create of creates) {
        expect(create[1]).not.toHaveProperty('switchExecution')
      }
      expect(request.mock.calls.some(([type]) => type === 'cancelCreateOrAttach')).toBe(false)
    } finally {
      deadline.dispose()
      request.mockRestore()
    }
  })

  it.each(['confirmation', 'anchor', 'stale-token', 'stale-token-cleanup-loss'] as const)(
    'chooses ordinary creation before dispatch when v54 lacks complete %s',
    async (missing) => {
      const connect = transport.connectDaemonSocket
      const stale = missing.startsWith('stale-token')
      let cleanupReplyLost = false
      const cleanupRequests = new Set<string>()
      let tracked: Promise<unknown> | undefined
      const writes: {
        type: string
        payload?: { switchExecution?: { phase: string }; settlement?: unknown; release?: unknown }
      }[] = []
      vi.spyOn(transport, 'connectDaemonSocket').mockImplementation(async (...args) => {
        const socket = await connect(...args)
        let receiverObserved = false
        const write = socket.write.bind(socket)
        vi.spyOn(socket, 'write').mockImplementation(
          (...bytes: Parameters<typeof socket.write>) => {
            const frame = JSON.parse(String(bytes[0]))
            writes.push(frame)
            if (frame.type === 'cancelCreateOrAttach' && !frame.payload?.release) {
              cleanupRequests.add(frame.id)
            }
            if (
              !receiverObserved &&
              (frame.payload?.switchExecution?.phase === 'prepare' ||
                (stale && frame.type === 'cancelCreateOrAttach'))
            ) {
              receiverObserved = true
              // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: modify only this fixture's actual authenticated response bytes.
              const peers = (fixture.server as unknown as { connections: DaemonClientConnections })
                .connections
              const peer = [...peers.values()].at(-1)?.controlSocket
              if (!peer) {
                throw new Error('fixture peer missing')
              }
              const respond = peer.write.bind(peer)
              vi.spyOn(peer, 'write').mockImplementation(
                (...reply: Parameters<typeof peer.write>) => {
                  const result = JSON.parse(String(reply[0]))
                  if (stale && result.payload?.retention) {
                    result.payload.retention = 'consumer-release-v1'
                  }
                  if (
                    missing === 'stale-token-cleanup-loss' &&
                    cleanupRequests.has(result.id) &&
                    !cleanupReplyLost
                  ) {
                    cleanupReplyLost = true
                    peer.destroy()
                    return true
                  }
                  if (
                    result.id === frame.id &&
                    frame.payload?.switchExecution?.phase === 'prepare'
                  ) {
                    if (missing === 'confirmation') {
                      delete result.payload.retention
                    } else if (missing === 'anchor') {
                      delete result.payload.anchor
                    } else {
                      result.payload.retention = 'consumer-release-v1'
                    }
                    return respond(`${JSON.stringify(result)}\n`)
                  }
                  return stale && result.payload?.retention
                    ? respond(`${JSON.stringify(result)}\n`)
                    : respond(...reply)
                }
              )
            }
            return write(...bytes)
          }
        )
        return socket
      })
      const deadline = agentSessionSwitchDeadline()
      try {
        const spawning = fixture.adapter.spawn({
          sessionId: 'bare-v54',
          cols: 80,
          rows: 24,
          switchExecution: {
            invocationId: 'bare-click',
            ...deadline,
            trackPhysical: (work) => {
              tracked = work
              return work
            }
          }
        })
        if (missing === 'stale-token-cleanup-loss') {
          await expect(spawning).rejects.toThrow('Connection lost')
          expect(cleanupReplyLost).toBe(true)
          if (!tracked) {
            throw new Error('known old anchor lost its ordinary settlement owner')
          }
          await tracked
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: inspect only the owned fixture receiver's retained handoff state.
          const receiver = fixture.server as unknown as {
            preparations: { hasOwedOutcomes(): boolean }
          }
          await vi.waitFor(() => expect(receiver.preparations.hasOwedOutcomes()).toBe(false))
          expect(writes.filter((frame) => frame.type === 'createOrAttach')).toHaveLength(1)
          expect(fixture.server.host.listSessions()).toEqual([])
          await expect(
            fixture.adapter.spawn({ sessionId: 'bare-v54', cols: 80, rows: 24 })
          ).resolves.toMatchObject({ id: 'bare-v54' })
        } else {
          await expect(spawning).resolves.toMatchObject({ id: 'bare-v54' })
        }
        expect(writes.filter((frame) => frame.type === 'createOrAttach')).toHaveLength(2)
        expect(writes.some((frame) => frame.payload?.switchExecution?.phase === 'commit')).toBe(
          false
        )
        const ordinary = writes.findLast((frame) => frame.type === 'createOrAttach')
        expect(ordinary?.payload).not.toHaveProperty('switchExecution')
        expect(fixture.server.host.listSessions()).toMatchObject([
          { sessionId: 'bare-v54', isAlive: true }
        ])
      } finally {
        deadline.dispose()
        vi.restoreAllMocks()
      }
    }
  )
}
