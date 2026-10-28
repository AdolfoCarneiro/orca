import '../../daemon/mock-descendant-sweep'
import type { DaemonServer } from '../../daemon/daemon-server'
import type { DaemonClientConnections } from '../../daemon/daemon-client-connections'
import * as transport from '../../daemon/daemon-client-socket-connect'
import { vi } from 'vitest'
export type SwitchSocketFaultState = {
  receiverDelay: number
  connectionUnavailable: boolean
  boundaryGcDrained: boolean
  commitRequestId: string
  ordinaryRequestId: string
  lateOrdinaryReply: (() => void) | undefined
  settlementOutcomes: string[]
}
export function installSwitchSocketFaults(
  boundary: string,
  ordinaryLoss: boolean,
  expired: boolean,
  outage: boolean,
  server: DaemonServer,
  wire: SwitchSocketFaultState
) {
  const connect = transport.connectDaemonSocket
  vi.spyOn(transport, 'connectDaemonSocket').mockImplementation(async (...args) => {
    if (wire.connectionUnavailable) {
      throw new Error('Connection lost')
    }
    const socket = await connect(...args)
    let received = ''
    socket.on('data', (chunk) => {
      received += String(chunk)
      const lines = received.split('\n')
      received = lines.pop() ?? ''
      for (const line of lines) {
        const response = JSON.parse(line)
        if (response.payload?.settlement) {
          wire.settlementOutcomes.push(response.payload.settlement.outcome)
        }
      }
    })
    const write = socket.write.bind(socket)
    vi.spyOn(socket, 'write').mockImplementation((...values: Parameters<typeof socket.write>) => {
      const frame = JSON.parse(String(values[0]))
      if (
        ordinaryLoss &&
        frame.type === 'createOrAttach' &&
        frame.payload?.sessionId !== 'unrelated-sibling' &&
        !frame.payload?.attachOnly
      ) {
        wire.ordinaryRequestId = frame.id
        if (boundary === 'legacy-never-created') {
          return true
        }
        // SAFETY: retain/drop only the owned original ordinary response bytes; sockets and sibling stay live.
        const peers = (server as unknown as { connections: DaemonClientConnections }).connections
        const peer = [...peers.values()].at(-1)?.controlSocket
        if (!peer) {
          throw new Error('ordinary fixture peer missing')
        }
        const respond = peer.write.bind(peer)
        vi.spyOn(peer, 'write').mockImplementation((...args: Parameters<typeof peer.write>) => {
          const response = JSON.parse(String(args[0]))
          if (response.id === wire.ordinaryRequestId) {
            wire.lateOrdinaryReply = () => {
              respond(...args)
            }
            return true
          }
          return respond(...args)
        })
      }

      if (
        (boundary === 'gc-outage' || boundary === 'native-gc-outage') &&
        frame.payload?.release &&
        !wire.boundaryGcDrained &&
        !wire.connectionUnavailable
      ) {
        wire.connectionUnavailable = true
        socket.destroy()
        return true
      }
      if (
        boundary === 'stale-daemon-token' &&
        frame.payload?.switchExecution?.phase === 'prepare'
      ) {
        // SAFETY: the fixture owns both authenticated sockets; simulate old development response bytes only.
        const peers = (server as unknown as { connections: DaemonClientConnections }).connections
        const peer = [...peers.values()].at(-1)?.controlSocket
        if (!peer) {
          throw new Error('fixture peer missing')
        }
        const respond = peer.write.bind(peer)
        vi.spyOn(peer, 'write').mockImplementation((...args: Parameters<typeof peer.write>) => {
          const reply = JSON.parse(String(args[0]))
          if (reply.payload?.retention) {
            reply.payload.retention = 'consumer-release-v1'
          }
          return respond(`${JSON.stringify(reply)}\n`)
        })
      }
      if (frame.payload?.switchExecution?.phase === 'commit') {
        wire.commitRequestId = frame.id
        if (expired) {
          wire.receiverDelay = 720_001
        }
        if (outage) {
          // SAFETY: this fixture owns both ends of this authenticated transport.
          const peers = (server as unknown as { connections: DaemonClientConnections }).connections
          const peer = [...peers.values()].at(-1)?.controlSocket
          if (!peer) {
            throw new Error('fixture control socket missing')
          }
          const respond = peer.write.bind(peer)
          vi.spyOn(peer, 'write').mockImplementation((...args: Parameters<typeof peer.write>) => {
            const response = JSON.parse(String(args[0]))
            if (response.payload?.settlement) {
              wire.settlementOutcomes.push(response.payload.settlement.outcome)
            }
            if (outage && response.id === wire.commitRequestId) {
              wire.connectionUnavailable = true
              peer.destroy()
              return true
            }
            return respond(...args)
          })
        }
      }
      return write(...values)
    })
    return socket
  })
}
