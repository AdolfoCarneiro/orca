import { expect, it } from 'vitest'
import { tearDownRuntime, type InstalledRuntime } from './structured-agent-session-runtime-teardown'

// An exit that settles while teardown drains recovery wakes delivery; a fresh child started then
// would only be killed by the teardown after it.
it('stops delivery before it drains the recovery of exits already observed', async () => {
  const order: string[] = []
  let releaseClose = () => {}
  const closing = new Promise<void>((resolve) => {
    releaseClose = resolve
  })
  let finished = false
  const installed: InstalledRuntime = {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: teardown calls only `stopDelivery` and `flushAllStreamedEvents` on the host.
    host: {
      stopDelivery: () => order.push('stop-delivery'),
      flushAllStreamedEvents: async () => {
        order.push('flush')
      }
    } as never,
    adapter: { closeAll: async () => undefined },
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: teardown calls only `close` on the database.
    journalDatabase: {
      close: async () => {
        order.push('close-database')
        await closing
      }
    } as never,
    waitForRecovery: async () => {
      order.push('wait-for-recovery')
    }
  }

  const teardown = tearDownRuntime(installed, 'quit').then(() => {
    finished = true
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(order).toContain('close-database')
  expect(finished).toBe(false)
  releaseClose()
  await teardown

  expect(order.slice(0, 2)).toEqual(['stop-delivery', 'wait-for-recovery'])
})
