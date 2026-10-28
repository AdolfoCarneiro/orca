import '../../daemon/mock-descendant-sweep'
import { expect, it, vi } from 'vitest'
import type { agentSessionSwitchDeadline } from '../../../shared/agent-session-switch-execution'
import type { RestTestRig } from './structured-agent-session-rest-test-rig'
import { HOST_TEST_SESSION as id } from './structured-agent-session-host-test-data'
import {
  agentSessionLeaseNeverAcquired,
  agentSessionLeasePossiblyWriting
} from '../../../shared/agent-session-lease-adjudication'
export function registerSwitchReservationTests(
  getRig: () => RestTestRig,
  clock: () => { deadline: ReturnType<typeof agentSessionSwitchDeadline>; expire: () => void }
) {
  it('drops an expired operation at its actual queued reservation without acquiring', async () => {
    const rig = getRig()

    const time = clock()
    const reserve = rig.store.reserveOwner
    vi.spyOn(rig.store, 'reserveOwner').mockImplementation((request, check) => {
      time.expire()
      return reserve(request, check)
    })
    expect(await rig.host.switchToChat(id, time.deadline)).toMatchObject({ ok: false })
    expect(rig.adapter.acquire).not.toHaveBeenCalled()
    expect(agentSessionLeaseNeverAcquired(rig.store.getRecord(id)!.lease)).toBe(true)
  })

  it('distinguishes never-acquired ownership from recovery without physical exit proof', async () => {
    const rig = getRig()

    expect(agentSessionLeaseNeverAcquired(rig.store.getRecord(id)!.lease)).toBe(true)
    await rig.host.switchToTerminal(id, clock().deadline)
    await rig.store.transitionHandoff(id, (record) => ({
      ...record,
      lease: { ...record.lease, minimumNextFence: 2 }
    }))
    expect(agentSessionLeasePossiblyWriting(rig.store.getRecord(id)!.lease)).toBe(true)
    await rig.restart()
    await expect(rig.host.switchToTerminal(id, clock().deadline)).rejects.toMatchObject({
      refusal: { details: { reason: 'ownerUnproven' } }
    })
    expect(rig.adapter.closeSession).not.toHaveBeenCalled()
  })

  it('rechecks source work at the actual queued visibility transaction and never retires a different tab', async () => {
    const rig = getRig()

    await rig.store.setSessionTabVisibility(id, false)
    await rig.store.setSessionTabVisibility(id, true, 'source-tab')
    let current = true
    const late = rig.store.setSwitchedSessionTabVisibility(id, 'source-tab', false, () => current)
    current = false
    expect(await late).toBe(false)
    expect(rig.store.getSessionTabId(id)).toBe('source-tab')
    expect(
      await rig.store.setSwitchedSessionTabVisibility(id, 'another-tab', false, () => true)
    ).toBe(false)
    expect(rig.store.getSessionTabId(id)).toBe('source-tab')
  })
}
