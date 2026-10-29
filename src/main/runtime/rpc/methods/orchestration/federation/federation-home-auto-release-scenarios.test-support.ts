import { expect, it, vi } from 'vitest'
import { getWorkerTerminalAutoReleaseScheduler } from '../../../../orchestration/worker-terminal-auto-release-scheduler'
import { getOrchestrationPeerCapabilityCache } from '../../../../orchestration/orchestration-peer-capability-cache'
import { ORCHESTRATION_WORKER_AUTO_RELEASE_RUNTIME_CAPABILITY } from '../../../../../../shared/protocol-version'
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

  async function settleOnOlderHost(): Promise<string> {
    harness.setWorkerAdvertisesAutoRelease(false)
    harness.setHomeOmitsAutoRelease(true)
    return args.settleRemotely()
  }

  async function releaseDueAtHome(): Promise<void> {
    vi.setSystemTime(Date.now() + GRACE_MS)
    await getWorkerTerminalAutoReleaseScheduler(harness.homeRuntime()).releaseDue()
  }

  it('sends no release when a retain lands while the deadline resolves host support', async () => {
    const dispatchId = await settleOnOlderHost()
    const cache = getOrchestrationPeerCapabilityCache(harness.homeRuntime())
    const resolve = cache.resolve.bind(cache)
    vi.spyOn(cache, 'resolve').mockImplementationOnce(async (probe) => {
      await args.retainFromHome(dispatchId)
      return resolve(probe)
    })

    await releaseDueAtHome()

    expect(harness.remoteCalls()).not.toContain('orchestration.federationRelease')
    expect(harness.workerRuntime().closeTerminal).not.toHaveBeenCalled()
  })

  it('releases once after a restart cut a claimed deadline short', async () => {
    const dispatchId = await settleOnOlderHost()
    vi.setSystemTime(Date.now() + GRACE_MS)
    // The claim committed, then the process died before sending anything.
    expect(harness.homeDb().claimDueFederatedHomeAutoReleases(Date.now())).toEqual([dispatchId])

    await releaseDueAtHome()

    expect(harness.workerRuntime().closeTerminal).toHaveBeenCalledTimes(1)
    expect(harness.homeDb().getFederatedDispatch(dispatchId)?.home_auto_release_state).toBe('ended')
  })

  it('still releases a worker whose host upgraded after settling it without a deadline', async () => {
    await settleOnOlderHost()
    harness.setWorkerAdvertisesAutoRelease(true)

    await releaseDueAtHome()

    expect(harness.workerRuntime().closeTerminal).toHaveBeenCalledTimes(1)
  })

  it('arms the home deadline when the host cannot be asked what it supports', async () => {
    const cache = getOrchestrationPeerCapabilityCache(harness.homeRuntime())
    const resolve = cache.resolve.bind(cache)
    vi.spyOn(cache, 'resolve').mockImplementation((probe) =>
      probe.capability === ORCHESTRATION_WORKER_AUTO_RELEASE_RUNTIME_CAPABILITY
        ? Promise.reject(new Error('status.get timed out'))
        : resolve(probe)
    )
    await settleOnOlderHost()
    vi.mocked(cache.resolve).mockRestore()

    await releaseDueAtHome()

    expect(harness.workerRuntime().closeTerminal).toHaveBeenCalledTimes(1)
  })
}
