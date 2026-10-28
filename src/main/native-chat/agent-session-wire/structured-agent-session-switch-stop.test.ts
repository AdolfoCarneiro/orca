import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { agentSessionSwitchDeadline } from '../../../shared/agent-session-switch-execution'
import {
  createRestTestRig,
  foundRestTestChat,
  REST_TEST_CALLER as caller,
  REST_TEST_SESSION as id,
  type RestTestRig
} from './structured-agent-session-rest-test-rig'
import { createTestParams } from './structured-agent-session-create-test-fixture'

let rig: RestTestRig
let deadline: ReturnType<typeof agentSessionSwitchDeadline>
beforeEach(async () => {
  rig = await createRestTestRig({ idleSweep: { intervalMs: 60_000 } })
  deadline = agentSessionSwitchDeadline()
})
afterEach(async () => {
  deadline.dispose()
  await rig.dispose()
})

it.each(['idle', 'replying'] as const)(
  'joins ordinary %s Stop and physical exit before reopening',
  async (state) => {
    if (state === 'replying') {
      await foundRestTestChat(rig)
    } else {
      expect(await rig.host.create(caller, createTestParams())).toMatchObject({ ok: true })
      expect(await rig.host.switchToChat(id)).toMatchObject({ ok: true })
    }
    const exit = Promise.withResolvers<boolean>()
    const entered = Promise.withResolvers<void>()
    rig.adapter.closeSession.mockImplementation(async () => {
      entered.resolve()
      return exit.promise
    })
    const acquired = rig.adapter.acquire.mock.calls.length
    const dispatches = rig.adapter.dispatch.mock.calls.length
    const destination = vi.fn(async () => rig.host.switchToChat(id))
    const switched = rig.host.stopForSwitch(id, caller, deadline).then(destination)
    await Promise.race([
      entered.promise,
      switched.then(() => {
        throw new Error('destination opened without stopping the source')
      })
    ])
    expect(destination).not.toHaveBeenCalled()
    expect(rig.adapter.acquire).toHaveBeenCalledTimes(acquired)
    exit.resolve(true)
    expect(await switched).toMatchObject({ ok: true })
    expect(destination).toHaveBeenCalledOnce()
    expect(rig.adapter.acquire).toHaveBeenCalledTimes(acquired + 1)
    expect(rig.adapter.dispatch).toHaveBeenCalledTimes(dispatches)
  }
)

it('keeps an unproven source owned and never starts its destination', async () => {
  expect(await rig.host.create(caller, createTestParams())).toMatchObject({ ok: true })
  expect(await rig.host.switchToChat(id)).toMatchObject({ ok: true })
  rig.adapter.closeSession.mockResolvedValue(false)
  const destination = vi.fn()
  await expect(rig.host.stopForSwitch(id, caller, deadline).then(destination)).rejects.toBeDefined()
  expect(rig.adapter.closeSession).toHaveBeenCalled()
  expect(destination).not.toHaveBeenCalled()
  expect(rig.host.collaboratorsForTests().sessions.get(id)?.child).toBeTruthy()
  expect((await rig.host.journalSnapshot(id)).items).toBeDefined()
})
