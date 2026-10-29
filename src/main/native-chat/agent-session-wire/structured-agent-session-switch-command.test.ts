import { registerSwitchReservationTests } from './structured-agent-session-switch-reservation.test-fixture'
import {
  verifySwitchOutcomeOutage,
  verifySwitchFinalDelivery
} from './structured-agent-session-switch-command.test-fixture'
import {
  installSwitchSocketFaults,
  type SwitchSocketFaultState
} from './structured-agent-session-switch-socket.test-fixture'
import '../../daemon/mock-descendant-sweep'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveAgentLaunchPaneVerdict } from '../../agent-launch/agent-launch-pane-attachment'
import { createPtySubprocess } from '../../daemon/pty-subprocess'
import { DaemonClient } from '../../daemon/client'
import { DaemonServer } from '../../daemon/daemon-server'
import type { DaemonClientConnections } from '../../daemon/daemon-client-connections'
import { DaemonPtyAdapter } from '../../daemon/daemon-pty-adapter'
import { getDaemonSocketPath } from '../../daemon/daemon-spawner'
import { createMockSubprocess } from '../../daemon/daemon-pty-adapter-test-harness'
import {
  setupMainOwnedWorkspace,
  WORKTREE_ID,
  TAB_ID
} from '../../runtime/main-owned-workspace-runtime-fixture'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { agentSessionSwitchDeadline } from '../../../shared/agent-session-switch-execution'
import { DEFAULT_SPAWN_ADMISSION_LIMITS } from '../../../shared/host-spawn-admission'
import {
  createRestTestRig,
  restTestSend,
  type RestTestRig
} from './structured-agent-session-rest-test-rig'
import {
  CREATE_TEST_CALLER as caller,
  createTestParams
} from './structured-agent-session-create-test-fixture'
import { HOST_TEST_SESSION as id } from './structured-agent-session-host-test-data'
import { verifyOrdinarySwitchLostOutcome } from './structured-agent-session-switch-command-ordinary.test-fixture'
import type * as LocalPtyUtils from '../../providers/local-pty-utils'
const nativePty = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node-pty', () => nativePty)
vi.mock('../../providers/local-pty-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof LocalPtyUtils>()),
  ensureNodePtySpawnHelperExecutable: () => {},
  getNodePtySpawnHelperCandidates: () => [process.execPath]
}))

vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

let initial: ReturnType<typeof createTestParams>
let rig: RestTestRig
const deadlines: ReturnType<typeof agentSessionSwitchDeadline>[] = []
function clock() {
  let now = 0
  const deadline = agentSessionSwitchDeadline(() => now, 720_000)
  deadlines.push(deadline)
  return {
    deadline,
    expire: () => {
      now = 720_001
    }
  }
}
beforeEach(async () => {
  rig = await createRestTestRig({ idleSweep: { intervalMs: 60_000 } })
  initial = createTestParams()
  expect(await rig.host.create(caller, initial)).toMatchObject({ ok: true })
})
afterEach(async () => {
  deadlines.forEach((deadline) => deadline.dispose())
  deadlines.length = 0
  await rig.dispose()
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

it('joins same-direction viewers while an ordinary Stop runs outside the command selection lane', async () => {
  const time = clock()
  expect(await rig.host.switchToChat(id)).toMatchObject({ ok: true })
  const exit = Promise.withResolvers<boolean>()
  const entered = Promise.withResolvers<void>()
  rig.adapter.closeSession.mockImplementation(async () => {
    entered.resolve()
    return exit.promise
  })
  const run = vi.fn(async () => {
    await rig.host.stopForSwitch(id, caller, time.deadline)
    return { status: 'completed' as const, sessionId: id }
  })
  const first = rig.host.runSwitch(id, 'first-viewer', time.deadline, run, {
    direction: 'terminal'
  })
  await Promise.race([entered.promise, first])
  const second = rig.host.runSwitch(id, 'second-viewer', clock().deadline, run, {
    direction: 'terminal'
  })
  exit.resolve(true)
  expect(await first).toEqual(await second)
  expect(run).toHaveBeenCalledOnce()
})

registerSwitchDaemonComposition(() => rig, clock, nativePty)

registerSwitchReservationTests(() => rig, clock)

function registerSwitchDaemonComposition(
  getRig: () => RestTestRig,
  clock: () => { deadline: ReturnType<typeof agentSessionSwitchDeadline>; expire: () => void },
  nativePty: { spawn: ReturnType<typeof vi.fn> }
) {
  it.each([
    'legacy-daemon',
    'legacy-lost-reply',
    'legacy-late-reply',
    'legacy-never-created',
    'stale-daemon-token',
    'native-failed',
    'native-outage',
    'native-gc-outage',
    'queued',
    'commit-expired',
    'host-cap',
    'gc-outage',
    'cap-outage',
    'expired-outage',
    'exit-outage',
    'dispatched',
    'disconnected',
    'recovery-failed',
    'recovery-used',
    'lost-reply',
    'missing-result',
    'live-unknown'
  ] as const)(
    'composes Stop, ordinary runtime creation, daemon sockets and retained physical work: %s',
    async (boundary) => {
      const rig = getRig()
      expect(await rig.host.switchToChat(id)).toMatchObject({ ok: true })
      const acquisitions = rig.adapter.acquire.mock.calls.length
      const stop = vi.spyOn(rig.host, 'stopForSwitch')
      const directory = await mkdtemp(join(tmpdir(), 'switch-daemon-composition-'))
      const time = clock()
      const ordinaryLoss = [
        'legacy-lost-reply',
        'legacy-late-reply',
        'legacy-never-created'
      ].includes(boundary)
      const compatible =
        ordinaryLoss || boundary === 'legacy-daemon' || boundary === 'stale-daemon-token'
      const nativeFailed = ['native-failed', 'native-outage', 'native-gc-outage'].includes(boundary)
      const outage = ['cap-outage', 'expired-outage', 'exit-outage', 'native-outage'].includes(
        boundary
      )
      const terminalOutcome = nativeFailed ? 'failed' : 'exited'
      nativePty.spawn.mockReset()
      nativePty.spawn.mockImplementation(() => {
        throw new Error('opaque native fixture failure')
      })
      const cap = boundary === 'host-cap' || boundary === 'cap-outage' || boundary === 'gc-outage'
      const expired = boundary === 'commit-expired' || boundary === 'expired-outage'
      const noFork = cap || expired
      const mobile =
        ordinaryLoss ||
        nativeFailed ||
        noFork ||
        outage ||
        ['recovery-failed', 'recovery-used'].includes(boundary)
      if (cap) {
        vi.stubEnv('ORCA_DAEMON_MAX_HOST_TERMINALS', outage ? '2' : '1')
      }
      if (outage) {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      }
      const stages: string[] = []
      let destination = ''
      let destinationTab = ''
      let destinationPane = ''
      const tabIds = () => session().tabsByWorktree[WORKTREE_ID]?.map((tab) => tab.id) ?? []
      const monotonic = performance.now.bind(performance)
      const wire: SwitchSocketFaultState = {
        receiverDelay: 0,
        connectionUnavailable: false,
        boundaryGcDrained: false,
        commitRequestId: '',
        ordinaryRequestId: '',
        lateOrdinaryReply: undefined,
        settlementOutcomes: []
      }
      if (expired) {
        vi.spyOn(performance, 'now').mockImplementation(() => monotonic() + wire.receiverDelay)
      }
      const dispatched = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const subprocess = createMockSubprocess()
      let usedViewer: DaemonClient | undefined
      let receiverCanceled = () => false
      const sibling = createMockSubprocess()
      const spawn = vi.fn(async (opts: { sessionId: string; isCanceled?: () => boolean }) => {
        if (opts.sessionId === 'unrelated-sibling') {
          return sibling
        }
        receiverCanceled = opts.isCanceled ?? (() => false)
        dispatched.resolve()
        if (nativeFailed) {
          return createPtySubprocess({ ...opts, cols: 80, rows: 24, cwd: directory })
        }
        await release.promise
        return subprocess
      })
      const server = new DaemonServer({
        socketPath: getDaemonSocketPath(directory),
        tokenPath: join(directory, 'test.token'),
        ...(boundary.startsWith('legacy-') ? { protocolVersion: 53 } : {}),
        spawnAdmission: 'enforce',
        preparePtySpawn: async () => {},
        ptySpawnHealthCheck: async () => {},
        spawnSubprocess: spawn
      })
      await server.start()

      let omitSettlement = boundary === 'missing-result'
      const omittedSettlement = Promise.withResolvers<void>()

      installSwitchSocketFaults(boundary, ordinaryLoss, expired, outage, server, wire)
      const respawn = vi.fn(async () => {
        if (wire.connectionUnavailable) {
          throw new Error('Recovery temporarily unavailable')
        }
      })
      const adapter = new DaemonPtyAdapter({
        socketPath: getDaemonSocketPath(directory),
        tokenPath: join(directory, 'test.token'),
        ...(boundary.startsWith('legacy-') ? { protocolVersion: 53 } : {}),
        ...(['recovery-failed', 'recovery-used'].includes(boundary) ? { respawn } : {})
      })
      const { runtime, bindPty, session } = setupMainOwnedWorkspace()
      Object.assign(runtime, {
        resolveTerminalWorkspaceLaunchScope: async () => ({
          id: WORKTREE_ID,
          path: directory,
          connectionId: null,
          repo: null,
          folderWorkspace: null
        })
      })
      // The controller's external provider boundary; admission, registration and publication stay real.
      runtime.setPtyController({
        write: () => true,
        kill: () => false,
        getForegroundProcess: async () => null,
        listProcesses: () => adapter.listProcesses(),
        spawn: async (opts) => {
          stages.push('controller-spawn')
          destination = opts.sessionId!
          destinationTab = opts.tabId!
          destinationPane = `${opts.tabId}:${opts.leafId}`
          const result = await adapter.spawn(opts)
          if (!opts.tabId || !opts.leafId) {
            throw new Error('ordinary pane identity missing')
          }
          bindPty({
            worktreeId: WORKTREE_ID,
            tabId: opts.tabId,
            leafId: opts.leafId,
            ptyId: result.id
          })
          return result
        }
      })
      const siblingViewer =
        outage || ordinaryLoss
          ? new DaemonClient({
              ...(boundary.startsWith('legacy-') ? { protocolVersion: 53 } : {}),
              socketPath: getDaemonSocketPath(directory),
              tokenPath: join(directory, 'test.token')
            })
          : undefined
      if (siblingViewer) {
        await siblingViewer.ensureConnected()
        await siblingViewer.request('createOrAttach', {
          sessionId: 'unrelated-sibling',
          cols: 80,
          rows: 24
        })
        spawn.mockClear()
      }
      const occupied = await Promise.all(
        Array.from(
          {
            length: cap
              ? 1
              : outage || nativeFailed || compatible
                ? 0
                : DEFAULT_SPAWN_ADMISSION_LIMITS.userResumeConcurrency
          },
          (_, index) =>
            server.automaticWork.gate.admit({
              clientId: `other-${index}`,
              declaredIntent: 'user-resume',
              hasAgentSessionClaim: false,
              hasHistorySeed: false,
              deadlineAt: Infinity
            })
        )
      )
      let physical: Promise<unknown> = Promise.resolve()
      const run = vi.fn(async () => {
        const current = await rig.host.stopForSwitch(id, caller, time.deadline)
        rig.host.guardSwitchWork(id, current)
        stages.push('stopped')
        const switchExecution = {
          invocationId: 'socket-switch',
          viewer: 'none' as const,
          signal: time.deadline.signal,
          remaining: time.deadline.remaining,
          check: () => {
            time.deadline.check()
            if (!current()) {
              throw new Error('newer work owns the source')
            }
          },
          trackPhysical: <T>(work: Promise<T>, recover?: () => Promise<void>) => {
            physical = Promise.allSettled([physical, work])
            return rig.host.trackSwitchPhysical(id, work, recover)
          }
        }
        await time.deadline.wait<
          | Awaited<ReturnType<typeof runtime.createMobileSessionTerminal>>
          | Awaited<ReturnType<typeof runtime.createTerminal>>
        >(
          mobile
            ? runtime.createMobileSessionTerminal(`id:${WORKTREE_ID}`, {
                command: 'cx',
                launchAgent: 'codex',
                clientMutationId: 'socket-switch',
                activate: false,
                signal: time.deadline.signal,
                switchExecution
              })
            : runtime.createTerminal(`id:${WORKTREE_ID}`, {
                command: 'cx',
                launchAgent: 'codex',
                spawnIntent: 'user-resume',
                sessionId: 'destination',
                presentation: 'background',
                signal: time.deadline.signal,
                switchExecution
              })
        )
        return { status: 'completed' as const, sessionId: id }
      })
      const operation = rig.host.runSwitch(id, 'socket-switch', time.deadline, run, {
        direction: 'terminal'
      })
      const outcome = operation.then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error })
      )
      try {
        if (ordinaryLoss) {
          await verifyOrdinarySwitchLostOutcome({
            get ordinaryRequestId() {
              return wire.ordinaryRequestId
            },
            boundary,
            dispatched,
            release,
            get lateOrdinaryReply() {
              return wire.lateOrdinaryReply
            },
            get destination() {
              return destination
            },
            get destinationTab() {
              return destinationTab
            },
            get destinationPane() {
              return destinationPane
            },
            server,
            time,
            outcome,
            rig,
            tabIds,
            runtime,
            run,
            clock,
            acquisitions,
            stop,
            spawn,
            sibling,
            subprocess,
            adapter
          })
          return
        }
        if (compatible) {
          await dispatched.promise
          expect(stop).toHaveBeenCalledOnce()
          expect(rig.adapter.closeSession).toHaveBeenCalledOnce()
          expect(rig.adapter.acquire).toHaveBeenCalledTimes(acquisitions)
          release.resolve()
          expect(await outcome).toMatchObject({ ok: true, value: { status: 'completed' } })
          expect(spawn).toHaveBeenCalledOnce()
          expect(wire.commitRequestId).toBe('')
          expect(stages.filter((stage) => stage === 'controller-spawn')).toHaveLength(1)
          expect(tabIds()).toHaveLength(2)
          await adapter.write(destination, 'new terminal input')
          await vi.waitFor(() =>
            expect(subprocess.write).toHaveBeenCalledWith('new terminal input')
          )
          expect(nativePty.spawn).not.toHaveBeenCalled()
          return
        }
        if (noFork || nativeFailed) {
          await outcome
        } else if (mobile) {
          await dispatched.promise
        } else {
          await Promise.race([
            vi.waitFor(
              () => expect(server.automaticWork.gate.snapshot().waiting, stages.join(',')).toBe(1),
              { timeout: 5000 }
            ),
            operation.then(() => {
              throw new Error('completed before daemon gate')
            })
          ])
        }
        if (!mobile || noFork) {
          expect(spawn).not.toHaveBeenCalled()
        }
        expect(rig.adapter.acquire).toHaveBeenCalledTimes(acquisitions)
        expect(stop).toHaveBeenCalledOnce()
        expect(rig.adapter.closeSession).toHaveBeenCalledOnce()
        if (cap) {
          expect(server.automaticWork.gate.snapshot()).toMatchObject({
            hostCapRefused: 1,
            waiting: 0
          })
        }
        if (outage) {
          await verifySwitchOutcomeOutage({
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
          })
          return
        }
        if (noFork || nativeFailed) {
          occupied.forEach((lease) => lease.abandon())
          expect(server.automaticWork.gate.snapshot()).toMatchObject({ terminals: 0, waiting: 0 })
          expect(await outcome).toMatchObject({ ok: false })
          if (nativeFailed) {
            expect(spawn).toHaveBeenCalledOnce()
            expect(nativePty.spawn).toHaveBeenCalledOnce()
            const original = await outcome
            await expect(
              rig.host.runSwitch(id, 'socket-switch', clock().deadline, run, {
                direction: 'terminal'
              })
            ).rejects.toBe(original.ok ? undefined : original.error)
            expect(run).toHaveBeenCalledOnce()
          } else {
            expect(spawn).not.toHaveBeenCalled()
          }
          expect(
            (
              await rig.host.send(
                caller,
                restTestSend(
                  'After receiver refused the expired commit',
                  rig.store.getRecord(id)!.lease.runtimeFence
                )
              )
            ).ok
          ).toBe(true)
        } else if (boundary === 'queued') {
          expect(
            (
              await rig.host.send(
                caller,
                restTestSend('A new instruction', rig.store.getRecord(id)!.lease.runtimeFence)
              )
            ).ok
          ).toBe(true)
        } else {
          occupied.forEach((lease) => lease.abandon())
          await dispatched.promise
          // Losing this observer does not settle the receiver's already-dispatched child.
          if (
            boundary === 'disconnected' ||
            boundary === 'recovery-failed' ||
            boundary === 'recovery-used'
          ) {
            // SAFETY: read this fixture server's connection registry only to break its exact external socket.
            const connections = (server as unknown as { connections: DaemonClientConnections })
              .connections
            const client = connections.values().next().value
            if (!client) {
              throw new Error('authenticated fixture connection missing')
            }
            wire.connectionUnavailable = boundary === 'recovery-failed'
            client.controlSocket.destroy()
            if (boundary === 'recovery-used') {
              subprocess.forceKill.mockImplementation(() => {
                throw new Error('physical close unavailable')
              })
              release.resolve()
            }
          } else if (boundary === 'lost-reply' || boundary === 'missing-result') {
            // Drop only this commit's external response bytes; the authenticated socket stays usable.
            const daemon = server as unknown as {
              connections: DaemonClientConnections
              preparations: { pending: Map<string, Set<{ requestId: string }>> }
            }
            const requestId = [...(daemon.preparations.pending.get(destination) ?? [])][0]
              ?.requestId
            const socket = daemon.connections.values().next().value?.controlSocket
            if (!requestId || !socket) {
              throw new Error('fixture commit transport missing')
            }
            const write = socket.write.bind(socket)
            vi.spyOn(socket, 'write').mockImplementation(
              (...args: Parameters<typeof socket.write>) => {
                const frame = JSON.parse(String(args[0]))
                if (frame.id === requestId) {
                  return true
                }
                if (omitSettlement && frame.payload?.settlement) {
                  omittedSettlement.resolve()
                  // A peer ignoring the optional field can acknowledge cancellation but cannot prove exit.
                  return write(`${JSON.stringify({ ...frame, payload: { canceled: true } })}\n`)
                }
                return write(...args)
              }
            )
            time.deadline.revoke()
          } else {
            time.deadline.revoke()
          }
        }
        stages.push('waiting-observer')
        expect(await outcome).toMatchObject({ ok: false })
        stages.push('observer-failed')
        if (boundary !== 'queued' && !noFork && !nativeFailed) {
          expect(rig.host.switchExecuting(id)).toBe(true)
          if (mobile) {
            expect(tabIds()).toContain(destinationTab)
            expect(runtime.hasLiveTerminalForPaneKey(destinationPane)).toBe(false)
            expect(
              await resolveAgentLaunchPaneVerdict(
                { worktreeId: WORKTREE_ID, paneKey: destinationPane },
                (paneKey) => runtime.hasLiveTerminalForPaneKey(paneKey)
              )
            ).toEqual({ kind: 'unconfirmed' })
            const observed = await outcome
            expect(observed).toMatchObject({
              error: {
                message: 'Connection lost'
              }
            })
          }
          stages.push('duplicate')
          const duplicate = await rig.host
            .runSwitch(id, 'other-viewer', clock().deadline, run, { direction: 'terminal' })
            .catch((error: unknown) => error)
          const observed = await outcome
          if (observed.ok) {
            throw new Error('revoked observer unexpectedly completed')
          }
          expect(duplicate).toBe(observed.error)
          await expect(
            rig.host.runSwitch(id, 'opposing-viewer', clock().deadline, run, { direction: 'chat' })
          ).rejects.toMatchObject({ refusal: { details: { reason: 'handoffInFlight' } } })
          expect(run).toHaveBeenCalledOnce()
          if (boundary === 'recovery-failed') {
            await vi.waitFor(() => expect(respawn).toHaveBeenCalled())
            const accepted = await rig.host.send(
              caller,
              restTestSend(
                'While recovery is unavailable',
                rig.store.getRecord(id)!.lease.runtimeFence
              )
            )
            expect(accepted.ok).toBe(true)
            // Run the ordinary start/recovery iteration to its bounded failure, not a mocked join.
            if (!accepted.ok) {
              throw new Error('new send was refused')
            }
            await vi.waitFor(async () =>
              expect(
                (await rig.host.journalSnapshot(id)).submissions.find(
                  (entry) => entry.clientMessageId === accepted.value.clientMessageId
                )?.dispatchState
              ).toBe('rejected')
            )
            expect(rig.adapter.acquire).toHaveBeenCalledTimes(acquisitions)
            expect(rig.host.switchExecuting(id)).toBe(true)
            wire.connectionUnavailable = false
          }
          stages.push('waiting-receiver-cancel')
          await vi.waitFor(() => expect(receiverCanceled()).toBe(true))
          if (boundary === 'recovery-failed') {
            expect(
              (
                await rig.host.send(
                  caller,
                  restTestSend(
                    'After recovery is restored',
                    rig.store.getRecord(id)!.lease.runtimeFence
                  )
                )
              ).ok
            ).toBe(true)
          }
          if (boundary === 'live-unknown') {
            subprocess.forceKill.mockImplementation(() => {
              throw new Error('physical close unavailable')
            })
          }
          release.resolve()
          if (boundary === 'live-unknown' || boundary === 'recovery-used') {
            await vi.waitFor(async () =>
              expect(await adapter.listProcesses()).toMatchObject([{ id: destination }])
            )
            let killsBeforeUse = subprocess.forceKill.mock.calls.length
            if (boundary === 'recovery-used') {
              usedViewer = new DaemonClient({
                socketPath: getDaemonSocketPath(directory),
                tokenPath: join(directory, 'test.token')
              })
              await usedViewer.ensureConnected()
              await usedViewer.request('createOrAttach', {
                sessionId: destination,
                cols: 80,
                rows: 24,
                attachOnly: true
              })
              killsBeforeUse = subprocess.forceKill.mock.calls.length
            }
            const accepted = await rig.host.send(
              caller,
              restTestSend(
                'While the terminal is still alive',
                rig.store.getRecord(id)!.lease.runtimeFence
              )
            )
            if (!accepted.ok) {
              throw new Error('new send was refused')
            }
            await vi.waitFor(async () =>
              expect(
                (await rig.host.journalSnapshot(id)).submissions.find(
                  (entry) => entry.clientMessageId === accepted.value.clientMessageId
                )?.dispatchState
              ).toBe('rejected')
            )
            expect(rig.adapter.acquire).toHaveBeenCalledTimes(acquisitions)
            expect(rig.host.switchExecuting(id)).toBe(true)
            if (mobile) {
              expect(tabIds()).toContain(destinationTab)
            }
            if (boundary === 'recovery-used') {
              expect(subprocess.forceKill).toHaveBeenCalledTimes(killsBeforeUse)
            }
            expect(server.host.listSessions()).toMatchObject([{ isAlive: true }])
            subprocess._simulateExit(137)
          }
          if (boundary === 'missing-result') {
            await omittedSettlement.promise
            expect(rig.host.switchExecuting(id)).toBe(true)
            const accepted = await rig.host.send(
              caller,
              restTestSend('Missing settlement proof', rig.store.getRecord(id)!.lease.runtimeFence)
            )
            if (!accepted.ok) {
              throw new Error('new send was refused')
            }
            await vi.waitFor(async () =>
              expect(
                (await rig.host.journalSnapshot(id)).submissions.find(
                  (entry) => entry.clientMessageId === accepted.value.clientMessageId
                )?.dispatchState
              ).toBe('rejected')
            )
            expect(rig.adapter.acquire).toHaveBeenCalledTimes(acquisitions)
            omitSettlement = false
            expect(
              (
                await rig.host.send(
                  caller,
                  restTestSend(
                    'After receiver proof is available',
                    rig.store.getRecord(id)!.lease.runtimeFence
                  )
                )
              ).ok
            ).toBe(true)
          }
          stages.push('waiting-physical')
          await physical.catch(() => {})
          stages.push('physical-finished')
          // The unused child is canceled through ordinary owned cleanup, with actual fake-I/O exit.
          if (boundary !== 'recovery-used') {
            expect(subprocess.forceKill).toHaveBeenCalled()
          }
          expect(server.host.listSessions().every((entry) => !entry.isAlive)).toBe(true)
          if (boundary !== 'recovery-failed' && boundary !== 'missing-result') {
            expect(
              (
                await rig.host.send(
                  caller,
                  restTestSend('After physical exit', rig.store.getRecord(id)!.lease.runtimeFence)
                )
              ).ok
            ).toBe(true)
          }
        } else {
          occupied.forEach((lease) => lease.abandon())
          await physical.catch(() => {})
          if (nativeFailed) {
            expect(spawn).toHaveBeenCalledOnce()
          } else {
            expect(spawn).not.toHaveBeenCalled()
          }
          expect(server.host.listSessions()).toEqual([])
          // Definitively unused publication is withdrawn by its ordinary owner.
          await vi.waitFor(() => expect(tabIds()).toEqual([TAB_ID]))
        }
        await verifySwitchFinalDelivery({
          rig,
          spawn,
          boundary,
          noFork,
          mobile,
          tabIds,
          adapter,
          server,
          wire,
          stop,
          run,
          stages
        })
      } finally {
        vi.useRealTimers()
        time.deadline.revoke()
        wire.connectionUnavailable = false
        omitSettlement = false
        occupied.forEach((lease) => lease.abandon())
        release.resolve()
        if (
          compatible ||
          boundary === 'live-unknown' ||
          boundary === 'recovery-used' ||
          boundary === 'exit-outage'
        ) {
          subprocess._simulateExit(137)
        }
        await outcome
        // An ordinary retry wakes retained receiver completion after restoring external transport.
        void rig.host
          .runSwitch(id, 'cleanup-observer', clock().deadline, run, { direction: 'terminal' })
          .catch(() => {})
        if (!ordinaryLoss) {
          await physical.catch(() => {})
        }

        usedViewer?.disconnect()
        sibling._simulateExit(0)
        siblingViewer?.disconnect()
        vi.useRealTimers()
        adapter.dispose()
        await server.shutdown()
        await rm(directory, { recursive: true, force: true })
      }
    },
    25_000
  )
}
