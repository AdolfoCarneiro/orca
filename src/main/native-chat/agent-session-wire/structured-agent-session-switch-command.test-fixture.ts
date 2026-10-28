import type { DaemonClientConnections } from '../../daemon/daemon-client-connections'
import type { DaemonServer } from '../../daemon/daemon-server'
import { expect, vi } from 'vitest'
import { restTestSend } from './structured-agent-session-rest-test-rig'
import { CREATE_TEST_CALLER as caller } from './structured-agent-session-create-test-fixture'
import { HOST_TEST_SESSION as id } from './structured-agent-session-host-test-data'
import { TAB_ID } from '../../runtime/main-owned-workspace-runtime-fixture'
import type { SwitchSocketFaultState } from './structured-agent-session-switch-socket.test-fixture'
import type { verifyOrdinarySwitchLostOutcome } from './structured-agent-session-switch-command-ordinary.test-fixture'
type OrdinaryFixture = Parameters<typeof verifyOrdinarySwitchLostOutcome>[0]
type OutageFixture = Pick<
  OrdinaryFixture,
  | 'server'
  | 'release'
  | 'outcome'
  | 'rig'
  | 'sibling'
  | 'acquisitions'
  | 'spawn'
  | 'stop'
  | 'run'
  | 'tabIds'
> & {
  noFork: boolean
  nativeFailed: boolean
  wire: SwitchSocketFaultState
  stages: string[]
  receiverCanceled: () => boolean
  terminalOutcome: string
  occupied: Awaited<ReturnType<DaemonServer['automaticWork']['gate']['admit']>>[]
}
export async function verifySwitchOutcomeOutage(fixture: OutageFixture) {
  const {
    noFork,
    nativeFailed,
    wire,
    server,
    stages,
    receiverCanceled,
    release,
    outcome,
    terminalOutcome,
    rig,
    sibling,
    acquisitions,
    occupied,
    spawn,
    stop,
    run,
    tabIds
  } = fixture

  if (!noFork && !nativeFailed) {
    // Real loss before the held creation returns; no receiver outcome can reach this observer.
    wire.connectionUnavailable = true
    // SAFETY: exact fixture connection only.
    const peers = (server as unknown as { connections: DaemonClientConnections }).connections
    // The adapter is the second authenticated pair; preserve the unrelated sibling.
    const sockets = [...peers.values()]
    sockets.at(-1)?.controlSocket.destroy()
    stages.push('waiting-receiver-cancel')
    await vi.waitFor(() => expect(receiverCanceled()).toBe(true))
    release.resolve()
  }
  expect(await outcome).toMatchObject({ ok: false })
  // SAFETY: inspect the exact receiver owner, never write its disposition or resolve its work.
  const retained = (
    server as unknown as { preparations: { retained: Map<string, { outcome?: string }> } }
  ).preparations.retained
  await vi.waitFor(() =>
    expect([...retained.values()]).toMatchObject([{ outcome: terminalOutcome }])
  )
  expect(rig.host.switchExecuting(id)).toBe(true)
  await vi.advanceTimersByTimeAsync(720_001)
  expect([...retained.values()]).toMatchObject([{ outcome: terminalOutcome }])
  expect(Object.keys([...retained.values()][0])).not.toContain('controller')
  expect(sibling.forceKill).not.toHaveBeenCalled()
  const unavailable = await rig.host.send(
    caller,
    restTestSend('While exact recovery is unavailable', rig.store.getRecord(id)!.lease.runtimeFence)
  )
  if (!unavailable.ok) {
    throw new Error('ordinary send was refused')
  }
  await vi.waitFor(async () =>
    expect(
      (await rig.host.journalSnapshot(id)).submissions.find(
        (entry) => entry.clientMessageId === unavailable.value.clientMessageId
      )?.dispatchState
    ).toBe('rejected')
  )
  expect(rig.adapter.acquire).toHaveBeenCalledTimes(acquisitions)
  occupied.forEach((lease) => lease.abandon())
  wire.connectionUnavailable = false
  const accepted = await rig.host.send(
    caller,
    restTestSend('After the same receiver recovers', rig.store.getRecord(id)!.lease.runtimeFence)
  )
  expect(accepted.ok).toBe(true)
  await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledOnce())
  await vi.waitFor(async () =>
    expect(
      (await rig.host.journalSnapshot(id)).submissions.some(
        (entry) =>
          entry.clientMessageId === (accepted.ok ? accepted.value.clientMessageId : '') &&
          entry.dispatchState === 'accepted'
      )
    ).toBe(true)
  )
  await vi.waitFor(() => expect(rig.host.switchExecuting(id)).toBe(false))
  await vi.waitFor(() => expect(retained.size).toBe(0))
  expect(wire.settlementOutcomes).toContain(terminalOutcome)
  expect(spawn).toHaveBeenCalledTimes(noFork ? 0 : 1)
  expect(stop).toHaveBeenCalledOnce()
  expect(run).toHaveBeenCalledOnce()
  await vi.waitFor(() => expect(tabIds()).toEqual([TAB_ID]))
  expect(server.host.listSessions()).toMatchObject([
    { sessionId: 'unrelated-sibling', isAlive: true }
  ])
}

type FinalDeliveryFixture = Pick<
  OrdinaryFixture,
  'rig' | 'spawn' | 'tabIds' | 'adapter' | 'server' | 'stop' | 'run'
> & {
  boundary: string
  noFork: boolean
  mobile: boolean
  wire: SwitchSocketFaultState
  stages: string[]
}
export async function verifySwitchFinalDelivery(fixture: FinalDeliveryFixture) {
  const { rig, spawn, boundary, noFork, mobile, tabIds, adapter, server, wire, stop, run, stages } =
    fixture
  await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledOnce())
  await vi.waitFor(async () =>
    expect(
      (await rig.host.journalSnapshot(id)).submissions.filter(
        (entry) => entry.dispatchState === 'accepted'
      )
    ).toHaveLength(1)
  )
  await vi.waitFor(() => expect(rig.host.switchExecuting(id)).toBe(false))
  expect(spawn).toHaveBeenCalledTimes(boundary === 'queued' || noFork ? 0 : 1)
  if (mobile) {
    await vi.waitFor(() => expect(tabIds()).toEqual([TAB_ID]))
  }
  if (boundary === 'gc-outage' || boundary === 'native-gc-outage') {
    // SAFETY: only inspect the actual fixture owners; GC debt cannot hold the already delivered send.
    const local = adapter as unknown as {
      switchReleaseCleanup: Map<string, unknown>
      switchReleaseDrain?: Promise<void>
    }
    const receiver = server as unknown as { preparations: { retained: Map<string, unknown> } }
    expect(local.switchReleaseCleanup.size).toBe(1)
    expect(receiver.preparations.retained.size).toBe(1)
    await vi.waitFor(() => expect(local.switchReleaseDrain).toBeUndefined())
    wire.connectionUnavailable = false
    // Do not lose the next release; one ordinary successful connection drains only exact GC debt.
    wire.boundaryGcDrained = true
    await adapter.listProcesses()
    await vi.waitFor(() => expect(local.switchReleaseCleanup.size).toBe(0))
    expect(receiver.preparations.retained.size).toBe(0)
  }
  expect(stop).toHaveBeenCalledOnce()
  expect(run).toHaveBeenCalledOnce()
  expect(stages.filter((stage) => stage === 'controller-spawn')).toHaveLength(1)
}
