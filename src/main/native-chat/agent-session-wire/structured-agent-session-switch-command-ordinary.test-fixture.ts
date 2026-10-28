import '../../daemon/mock-descendant-sweep'
import type { DaemonServer } from '../../daemon/daemon-server'
import type { DaemonPtyAdapter } from '../../daemon/daemon-pty-adapter'
import type { createMockSubprocess } from '../../daemon/daemon-pty-adapter-test-harness'
import type { setupMainOwnedWorkspace } from '../../runtime/main-owned-workspace-runtime-fixture'
import { expect, vi } from 'vitest'
import type { agentSessionSwitchDeadline } from '../../../shared/agent-session-switch-execution'
import { restTestSend, type RestTestRig } from './structured-agent-session-rest-test-rig'
import { CREATE_TEST_CALLER as caller } from './structured-agent-session-create-test-fixture'
import { HOST_TEST_SESSION as id } from './structured-agent-session-host-test-data'
export async function verifyOrdinarySwitchLostOutcome(fixture: {
  ordinaryRequestId: string
  boundary: string
  dispatched: ReturnType<typeof Promise.withResolvers<void>>
  release: ReturnType<typeof Promise.withResolvers<void>>
  lateOrdinaryReply: (() => void) | undefined
  destination: string
  destinationTab: string
  destinationPane: string
  server: DaemonServer
  time: { deadline: ReturnType<typeof agentSessionSwitchDeadline> }
  outcome: Promise<{ ok: true; value: { status: string } } | { ok: false; error: unknown }>
  runtime: ReturnType<typeof setupMainOwnedWorkspace>['runtime']
  rig: RestTestRig
  tabIds: () => string[]
  run: () => Promise<{ status: 'completed'; sessionId: string }>
  clock: () => { deadline: ReturnType<typeof agentSessionSwitchDeadline> }
  acquisitions: number
  stop: ReturnType<typeof vi.spyOn>
  spawn: ReturnType<typeof vi.fn>
  sibling: ReturnType<typeof createMockSubprocess>
  subprocess: ReturnType<typeof createMockSubprocess>
  adapter: DaemonPtyAdapter
}) {
  const {
    boundary,
    dispatched,
    release,
    server,
    time,
    outcome,
    runtime,
    rig,
    tabIds,
    run,
    clock,
    acquisitions,
    stop,
    spawn,
    sibling,
    subprocess,
    adapter
  } = fixture

  if (boundary !== 'legacy-never-created') {
    await dispatched.promise
    release.resolve()
    await vi.waitFor(() => expect(fixture.lateOrdinaryReply).toBeTypeOf('function'))
    expect(
      server.host
        .listSessions()
        .some((entry) => entry.sessionId === fixture.destination && entry.isAlive)
    ).toBe(true)
  } else {
    await vi.waitFor(() => expect(fixture.ordinaryRequestId).not.toBe(''))
  }
  time.deadline.revoke()
  expect(await outcome).toMatchObject({ ok: false })
  expect(rig.host.switchExecuting(id)).toBe(true)
  expect(tabIds()).toContain(fixture.destinationTab)
  if (boundary === 'legacy-late-reply') {
    fixture.lateOrdinaryReply!()
    await vi.waitFor(() =>
      expect(runtime.hasLiveTerminalForPaneKey(fixture.destinationPane)).toBe(true)
    )
  } else {
    const duplicate = await rig.host
      .runSwitch(id, 'other-viewer', clock().deadline, run, { direction: 'terminal' })
      .catch((error: unknown) => error)
    const first = await outcome
    if (first.ok) {
      throw new Error('original observer unexpectedly completed')
    }
    expect(duplicate).toBe(first.error)
    const unavailable = await rig.host.send(
      caller,
      restTestSend(
        'Recover the original ordinary outcome',
        rig.store.getRecord(id)!.lease.runtimeFence
      )
    )
    if (!unavailable.ok) {
      throw new Error('ordinary send refused')
    }
    await vi.waitFor(async () =>
      expect(
        (await rig.host.journalSnapshot(id)).submissions.find(
          (entry) => entry.clientMessageId === unavailable.value.clientMessageId
        )?.dispatchState
      ).toBe('rejected')
    )
    expect(rig.adapter.acquire).toHaveBeenCalledTimes(acquisitions)
    expect(rig.host.switchExecuting(id)).toBe(true)
    expect(run).toHaveBeenCalledOnce()
    expect(stop).toHaveBeenCalledOnce()
    if (boundary === 'legacy-never-created') {
      expect(spawn).not.toHaveBeenCalled()
      expect(server.host.listSessions()).toMatchObject([
        { sessionId: 'unrelated-sibling', isAlive: true }
      ])
      return
    }
    expect(adapter.getActiveSessionIds()).toContain(fixture.destination)
  }
  expect(spawn).toHaveBeenCalledOnce()
  expect(sibling.forceKill).not.toHaveBeenCalled()
  subprocess._simulateExit(0)
  await vi.waitFor(() => expect(rig.host.switchExecuting(id)).toBe(false), { timeout: 10000 })
  const accepted = await rig.host.send(
    caller,
    restTestSend(
      'After the original ordinary child exited',
      rig.store.getRecord(id)!.lease.runtimeFence
    )
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
  expect(stop).toHaveBeenCalledOnce()
  expect(run).toHaveBeenCalledOnce()
  expect(spawn).toHaveBeenCalledOnce()
  expect(
    server.host.listSessions().find((entry) => entry.sessionId === 'unrelated-sibling')?.isAlive
  ).toBe(true)
}
