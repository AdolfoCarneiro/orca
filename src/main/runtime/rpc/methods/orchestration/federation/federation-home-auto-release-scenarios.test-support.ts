import { expect, it, vi } from 'vitest'
import { getWorkerTerminalAutoReleaseScheduler } from '../../../../orchestration/worker-terminal-auto-release-scheduler'
import {
  GRACE_MS,
  type AutoReleaseScenarioHarness
} from './federation-auto-release-scenarios.test-support'

export function registerHomeAutoReleaseScenarios(args: {
  harness: AutoReleaseScenarioHarness
  settleRemotely: () => Promise<string>
  listFromHome: (dispatchId: string) => Promise<unknown>
  retainFromHome: (dispatchId: string) => Promise<unknown>
}): void {
  const { harness } = args

  it.each(['released', 'retained'] as const)(
    'keeps the deadline at the home for a host that predates automatic release (%s)',
    async (outcome) => {
      harness.setWorkerAdvertisesAutoRelease(false)
      // That host ignores the ack's opt-in.
      harness.setHomeOmitsAutoRelease(true)
      const dispatchId = await args.settleRemotely()
      expect(harness.workerDb().getWorkerTerminalResourceByOwner(dispatchId)?.auto_release_at).toBe(
        null
      )
      await expect(args.listFromHome(dispatchId)).resolves.toMatchObject({
        autoReleaseAt: '2026-10-27T12:02:00Z'
      })
      if (outcome === 'retained') {
        await expect(args.retainFromHome(dispatchId)).resolves.toMatchObject({ ok: true })
      }

      vi.setSystemTime(Date.now() + GRACE_MS)
      await getWorkerTerminalAutoReleaseScheduler(harness.homeRuntime()).releaseDue()

      if (outcome === 'retained') {
        expect(harness.remoteCalls()).not.toContain('orchestration.federationRelease')
        expect(harness.workerRuntime().closeTerminal).not.toHaveBeenCalled()
        return
      }
      expect(harness.workerRuntime().closeTerminal).toHaveBeenCalledTimes(1)
      expect(harness.workerDb().getWorkerTerminalResourceByOwner(dispatchId)?.release_state).toBe(
        'released'
      )
      expect(harness.homeDb().getWorkerDispatch(dispatchId)?.stage).toBe('released')
      expect(harness.homeDb().getFederatedDispatch(dispatchId)?.home_auto_release_state).toBe(
        'ended'
      )
    }
  )
}
