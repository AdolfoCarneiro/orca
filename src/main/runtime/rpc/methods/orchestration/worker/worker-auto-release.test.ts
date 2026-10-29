import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reconcileRequestedWorkerTerminalReleases } from '../../../../orchestration/worker-terminal-release-reconciliation'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { getWorkerTerminalAutoReleaseScheduler } from '../../../../orchestration/worker-terminal-auto-release-scheduler'
import { createOrchestrationWorkerReleaseHarness } from './worker-release.test-support'
import { ORCHESTRATION_WORKER_CHAT_TOUCH_CLIENT_CAPABILITY } from '../../../../../../shared/orchestration-runtime-capabilities'

const GRACE_MS = 2 * 60_000
const CHAT_TOUCH = ORCHESTRATION_WORKER_CHAT_TOUCH_CLIENT_CAPABILITY

describe('orchestration worker automatic release', () => {
  const h = createOrchestrationWorkerReleaseHarness()

  afterEach(() => {
    getWorkerTerminalAutoReleaseScheduler(h.runtime).clear()
    h.cleanup()
    vi.useRealTimers()
  })

  function setupWithFakeClock(): void {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.setSystemTime(new Date('2026-10-27T12:00:00Z'))
    h.setup()
  }

  it.each(['succeeded', 'failed'] as const)(
    'releases a %s worker once its grace period ends and keeps its output readable',
    async (outcome) => {
      setupWithFakeClock()
      const { dispatchId } = await h.startSettledWorker(outcome)
      await expect(
        h.call('orchestration.workerShow', { dispatch: dispatchId })
      ).resolves.toMatchObject({
        autoReleaseAt: '2026-10-27T12:02:00Z',
        terminalResource: { autoReleaseAt: '2026-10-27T12:02:00Z' },
        projection: { nextAction: { kind: 'none' } }
      })

      await vi.advanceTimersByTimeAsync(GRACE_MS - 1_000)
      expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1_000)

      await vi.waitFor(() =>
        expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('released')
      )
      expect(h.runtime.closeTerminal).toHaveBeenCalledTimes(1)
      expect(h.runtime.closeTerminal).toHaveBeenCalledWith('term_worker')
      await expect(
        h.call('orchestration.workerRead', { dispatch: dispatchId })
      ).resolves.toMatchObject({
        terminal: { tail: ['worker output line 1', 'worker output line 2'] }
      })
    }
  )

  it('never extends the deadline for a repeated worker_done', async () => {
    setupWithFakeClock()
    const { taskId, dispatchId } = await h.startSettledWorker()
    const armed = h.db.getWorkerTerminalResourceByOwner(dispatchId)?.auto_release_at
    await vi.advanceTimersByTimeAsync(60_000)

    h.settle(taskId, dispatchId, 'succeeded')

    expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)?.auto_release_at).toBe(armed)
  })

  it('hands a terminal reused during the grace period to the new Dispatch', async () => {
    setupWithFakeClock()
    const settled = await h.startSettledWorker()

    const reuse = await h.startWorker({ terminal: 'term_worker' })
    await vi.advanceTimersByTimeAsync(2 * GRACE_MS)

    expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
    expect(h.db.getWorkerTerminalResourceByOwner(settled.dispatchId)).toBeUndefined()
    expect(h.db.getWorkerTerminalResourceByOwner(reuse.dispatchId)).toMatchObject({
      release_state: 'not_requested',
      auto_release_at: null
    })
  })

  it.each([
    [
      'worker-retain',
      'orchestration.workerRetain',
      (dispatchId: string) => ({ dispatch: dispatchId })
    ],
    [
      'Keep Worker Open action',
      'orchestration.workerTerminalUserKeep',
      () => ({ paneKey: h.workerPaneKey })
    ],
    ['user input', 'orchestration.workerTerminalUserInput', () => ({ paneKey: h.workerPaneKey })]
  ] as const)(
    'keeps a terminal the %s claimed before the deadline',
    async (_kind, method, params) => {
      setupWithFakeClock()
      const { dispatchId } = await h.startSettledWorker()

      await h.call(method, params(dispatchId))
      await vi.advanceTimersByTimeAsync(2 * GRACE_MS)

      expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
      expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
        release_state: 'retained',
        auto_release_at: null
      })
    }
  )

  it('keeps a terminal the user typed into while its output was being captured', async () => {
    setupWithFakeClock()
    const { dispatchId } = await h.startSettledWorker()
    const pendingRead = h.deferred<Awaited<ReturnType<OrcaRuntimeService['readTerminal']>>>()
    vi.mocked(h.runtime.readTerminal).mockReturnValue(pendingRead.promise)

    await vi.advanceTimersByTimeAsync(GRACE_MS)
    await vi.waitFor(() => expect(h.runtime.readTerminal).toHaveBeenCalledTimes(1))
    await h.call('orchestration.workerTerminalUserInput', { paneKey: h.workerPaneKey })
    pendingRead.resolve({
      handle: 'term_worker',
      status: 'running',
      tail: ['typed during capture'],
      truncated: false,
      nextCursor: '1'
    })

    await vi.waitFor(() =>
      expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)?.ownership_state).toBe('user_owned')
    )
    expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
  })

  it.each(['before the deadline', 'while the automatic release captures output'] as const)(
    'lets typing win %s when the renderer never reports takeover',
    async (moment) => {
      setupWithFakeClock()
      const { dispatchId } = await h.startSettledWorker()
      const pendingRead = h.deferred<Awaited<ReturnType<OrcaRuntimeService['readTerminal']>>>()
      if (moment === 'before the deadline') {
        await vi.advanceTimersByTimeAsync(30_000)
      } else {
        vi.mocked(h.runtime.readTerminal).mockReturnValue(pendingRead.promise)
        await vi.advanceTimersByTimeAsync(GRACE_MS)
        await vi.waitFor(() => expect(h.runtime.readTerminal).toHaveBeenCalledTimes(1))
      }
      vi.spyOn(h.runtime, 'getTerminalLastDrivingInputAt').mockReturnValue(Date.now())
      pendingRead.resolve({
        handle: 'term_worker',
        status: 'running',
        tail: ['typed during capture'],
        truncated: false,
        nextCursor: '1'
      })
      await vi.advanceTimersByTimeAsync(2 * GRACE_MS)

      expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
      expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
        ownership_state: 'user_owned',
        auto_release_at: null
      })
    }
  )

  it('still releases on time when the last typing came before worker_done', async () => {
    setupWithFakeClock()
    const typedBeforeDone = Date.now()
    vi.spyOn(h.runtime, 'getTerminalLastDrivingInputAt').mockReturnValue(typedBeforeDone)
    await vi.advanceTimersByTimeAsync(1_000)
    await h.startSettledWorker()

    await vi.advanceTimersByTimeAsync(GRACE_MS)

    await vi.waitFor(() => expect(h.runtime.closeTerminal).toHaveBeenCalledTimes(1))
  })

  it('lets an explicit worker-release close a terminal the user typed into', async () => {
    setupWithFakeClock()
    const { dispatchId } = await h.startSettledWorker()
    vi.spyOn(h.runtime, 'getTerminalLastDrivingInputAt').mockReturnValue(Date.now())

    await expect(
      h.call('orchestration.workerRelease', { dispatch: dispatchId })
    ).resolves.toMatchObject({ state: 'released' })
    expect(h.runtime.closeTerminal).toHaveBeenCalledTimes(1)
  })

  it('does not arm a worker retained before it reported', async () => {
    setupWithFakeClock()
    const { taskId, dispatchId } = await h.startWorker()
    await h.call('orchestration.workerRetain', { dispatch: dispatchId })

    h.settle(taskId, dispatchId, 'succeeded')
    await vi.advanceTimersByTimeAsync(2 * GRACE_MS)

    expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)?.auto_release_at).toBeNull()
    expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
  })

  it.each([
    ['silent', async () => (await h.startWorker()).dispatchId],
    [
      'abandoned',
      async () => {
        const { dispatchId } = await h.startWorker()
        await h.call('orchestration.workerAbandon', { dispatch: dispatchId })
        return dispatchId
      }
    ],
    [
      'pre-upgrade settled',
      async () => {
        const { dispatchId } = await h.startSettledWorker()
        h.db.db
          .prepare(
            'UPDATE worker_terminal_resources SET auto_release_at = NULL, auto_release_dispatch_id = NULL WHERE owner_dispatch_id = ?'
          )
          .run(dispatchId)
        return dispatchId
      }
    ]
  ] as const)('leaves a %s worker to manual release', async (_state, start) => {
    setupWithFakeClock()
    const dispatchId = await start()

    getWorkerTerminalAutoReleaseScheduler(h.runtime).rearm()
    await vi.advanceTimersByTimeAsync(2 * GRACE_MS)

    expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
    expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)?.auto_release_at).toBeNull()
  })

  describe('across a restart', () => {
    let userDataDir: string

    beforeEach(() => {
      userDataDir = mkdtempSync(join(tmpdir(), 'orca-auto-release-restart-'))
    })
    afterEach(() => rmSync(userDataDir, { recursive: true, force: true }))

    function setupFileBacked(): void {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      vi.setSystemTime(new Date('2026-10-27T12:00:00Z'))
      h.setup({ userDataDir })
    }

    async function expectReadableArchive(dispatchId: string): Promise<void> {
      await expect(
        h.call('orchestration.workerRead', { dispatch: dispatchId })
      ).resolves.toMatchObject({
        terminal: { tail: ['worker output line 1', 'worker output line 2'] }
      })
    }

    it('releases a deadline missed while the app was closed once, when the database reopens', async () => {
      setupFileBacked()
      const { dispatchId } = await h.startSettledWorker()

      h.restart()
      expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
      vi.setSystemTime(Date.now() + 2 * GRACE_MS)
      h.restart()
      await vi.advanceTimersByTimeAsync(0)

      await vi.waitFor(() =>
        expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('released')
      )
      expect(h.runtime.closeTerminal).toHaveBeenCalledTimes(1)
      await expectReadableArchive(dispatchId)

      h.restart()
      await vi.advanceTimersByTimeAsync(2 * GRACE_MS)
      expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
    })

    it.each(['requested', 'releasing'] as const)(
      'finishes an automatic release interrupted while %s after a restart',
      async (interruptedAt) => {
        setupFileBacked()
        const { dispatchId } = await h.startSettledWorker()
        // Hold the step after which a crash leaves the row in this state.
        const held =
          interruptedAt === 'requested'
            ? vi.mocked(h.runtime.readTerminal).mockReturnValue(new Promise(() => {}))
            : vi.mocked(h.runtime.closeTerminal).mockReturnValue(new Promise(() => {}))
        await vi.advanceTimersByTimeAsync(GRACE_MS)
        await vi.waitFor(() => expect(held).toHaveBeenCalled())
        expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe(interruptedAt)

        h.restart()
        await reconcileRequestedWorkerTerminalReleases(h.runtime)
        await reconcileRequestedWorkerTerminalReleases(h.runtime)

        expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe('released')
        expect(h.runtime.closeTerminal).toHaveBeenCalledTimes(1)
        await expectReadableArchive(dispatchId)
      }
    )
  })

  describe('chat workers', () => {
    const chatPaneKey = 'structured-agent-session-s1:dddddddd-dddd-4ddd-8ddd-dddddddddddd'

    function startChatWorker(): { taskId: string; dispatchId: string } {
      const started = h.db.createStartingWorkerDispatch({
        creator: { kind: 'system' },
        maxDepth: Number.MAX_SAFE_INTEGER,
        taskSpec: 'chat worker',
        taskRunId: 'run_legacy_local',
        startOptions: {}
      })
      h.db.prepareStartingWorkerAuthority({
        dispatchId: started.dispatch.id,
        handle: 'structworker_1',
        paneKey: chatPaneKey,
        processIncarnation: 'structured:s1',
        hostScope: JSON.stringify({ kind: 'local', hostId: 'local' }),
        worktreeId: 'wt',
        setupState: 'not_applicable',
        effects: [],
        terminalOwnership: 'created'
      })
      h.db.markWorkerDispatchReady(started.dispatch.id)
      return { taskId: started.task.id, dispatchId: started.dispatch.id }
    }

    function startSettledChatWorker(): string {
      const { taskId, dispatchId } = startChatWorker()
      h.settle(taskId, dispatchId, 'succeeded')
      return dispatchId
    }

    const touch = (): Promise<unknown> =>
      h.call('orchestration.workerChatTouch', { paneKey: chatPaneKey })

    it.each([
      ['every connected client reports touches', [[CHAT_TOUCH]], '2026-10-27 12:02:00'],
      ['a connected client cannot report touches', [[CHAT_TOUCH], []], null]
    ] as const)('arms on worker_done only when %s', (_case, clients, deadline) => {
      setupWithFakeClock()
      h.runtime.bindConnectedClientCapabilities(() => clients)

      const dispatchId = startSettledChatWorker()

      expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)?.auto_release_at).toBe(deadline)
    })

    it.each(['before the deadline', 'while the automatic release captures output'] as const)(
      'keeps a finished chat the user touched %s',
      async (moment) => {
        setupWithFakeClock()
        const dispatchId = startSettledChatWorker()
        if (moment !== 'before the deadline') {
          h.db.claimDueWorkerTerminalAutoReleases(Date.now() + GRACE_MS)
        }

        await expect(touch()).resolves.toEqual({ changed: 1 })

        const resource = h.db.getWorkerTerminalResourceByOwner(dispatchId)!
        expect(resource).toMatchObject({
          ownership_state: 'user_owned',
          release_state: 'retained',
          retained_reason: 'user_takeover',
          auto_release_at: null
        })
        expect(
          h.db.commitWorkerTerminalArchiveForRelease({
            dispatchId,
            resourceId: resource.id,
            kind: 'transcript_pin',
            content: '{}',
            archiveSource: 'transcript',
            archiveStatus: 'captured'
          }).release_state
        ).toBe('retained')
      }
    )

    function claimAndCommitChatRelease(dispatchId: string): string {
      h.db.claimDueWorkerTerminalAutoReleases(Date.now() + GRACE_MS)
      const resourceId = h.db.getWorkerTerminalResourceByOwner(dispatchId)!.id
      h.db.commitWorkerTerminalArchiveForRelease({
        dispatchId,
        resourceId,
        kind: 'transcript_pin',
        content: '{}',
        archiveSource: 'transcript',
        archiveStatus: 'captured'
      })
      return resourceId
    }

    it('lets a touch after the archive commit win until the close is admitted, then not', async () => {
      setupWithFakeClock()
      const touched = claimAndCommitChatRelease(startSettledChatWorker())
      await expect(touch()).resolves.toEqual({ changed: 1 })
      expect(h.db.admitWorkerChatReleaseClose(touched)).toBe(false)

      const closing = claimAndCommitChatRelease(startSettledChatWorker())
      expect(h.db.admitWorkerChatReleaseClose(closing)).toBe(true)
      await expect(touch()).resolves.toEqual({ changed: 0 })
    })

    it('falls back to manual release when a client that cannot report touches joins before the close', () => {
      setupWithFakeClock()
      const dispatchId = startSettledChatWorker()
      const resourceId = claimAndCommitChatRelease(dispatchId)
      h.runtime.bindConnectedClientCapabilities(() => [[]])

      expect(h.db.admitWorkerChatReleaseClose(resourceId)).toBe(false)

      expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
        ownership_state: 'owned',
        release_state: 'not_requested',
        auto_release_at: null
      })
      expect(h.db.getWorkerTerminalArchive(dispatchId)).toBeUndefined()
    })

    it('ignores a touch on a running worker and on an explicit release', async () => {
      setupWithFakeClock()
      const { taskId, dispatchId } = startChatWorker()
      await expect(touch()).resolves.toEqual({ changed: 0 })

      h.settle(taskId, dispatchId, 'succeeded')
      h.db.requestWorkerTerminalRelease(dispatchId)
      await expect(touch()).resolves.toEqual({ changed: 0 })
      expect(h.db.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
        ownership_state: 'owned',
        release_state: 'requested'
      })
    })
  })
})
