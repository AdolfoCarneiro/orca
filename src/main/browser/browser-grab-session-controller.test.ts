import { EventEmitter } from 'node:events'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserGrabSessionController } from './browser-grab-session-controller'

function createGuest() {
  const events = new EventEmitter()
  const execute = vi.fn<(script: string) => Promise<unknown>>()
  execute.mockResolvedValue({ ok: true, value: { __orcaCancelled: true } })
  const state = { loading: false, destroyed: false }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies every guest member the controller uses.
  const guest = {
    id: 101,
    getURL: () => 'https://example.com/',
    isLoadingMainFrame: () => state.loading,
    isDestroyed: () => state.destroyed,
    on: events.on.bind(events),
    once: events.once.bind(events),
    off: events.off.bind(events),
    mainFrame: { executeJavaScript: execute }
  } as unknown as Electron.WebContents
  return { guest, events, execute, state }
}

afterEach(() => vi.useRealTimers())

describe('grab frame reply lifetime', () => {
  it.each([null, {}, { ok: 'yes' }, { ok: false }, { ok: false, message: 42 }])(
    'reports malformed frame envelopes as errors: %j',
    async (reply) => {
      const { guest, execute } = createGuest()
      execute.mockResolvedValueOnce(reply)
      const controller = new BrowserGrabSessionController()

      await expect(controller.awaitGrabSelection('tab', 'op', guest)).resolves.toEqual({
        opId: 'op',
        kind: 'error',
        reason: 'Selection failed'
      })
      expect(controller.hasActiveGrabOp('tab')).toBe(false)
    }
  )

  it.each([
    ['Grab not armed', 'error'],
    ['cancelled', 'cancelled']
  ] as const)('preserves a guest error message: %s', async (message, kind) => {
    const { guest, execute } = createGuest()
    execute.mockResolvedValueOnce({ ok: false, message })
    const controller = new BrowserGrabSessionController()

    await expect(controller.awaitGrabSelection('tab', 'op', guest)).resolves.toEqual({
      opId: 'op',
      kind,
      reason: kind === 'cancelled' ? 'user' : message
    })
  })

  it('carries a thrown guest Error through the generated plain-data envelope', async () => {
    const { guest, execute } = createGuest()
    execute.mockImplementation((script) => Promise.resolve(runInNewContext(script, { window: {} })))
    const controller = new BrowserGrabSessionController()

    await expect(controller.awaitGrabSelection('tab', 'op', guest)).resolves.toEqual({
      opId: 'op',
      kind: 'error',
      reason: 'Grab not armed'
    })
  })

  it.each(['throw', 'reject'] as const)(
    'settles when native frame execution fails: %s',
    async (how) => {
      const { guest, execute } = createGuest()
      if (how === 'throw') {
        execute.mockImplementationOnce(() => {
          throw new Error('Frame unavailable')
        })
      } else {
        execute.mockRejectedValueOnce(new Error('Frame unavailable'))
      }
      const controller = new BrowserGrabSessionController()

      await expect(controller.awaitGrabSelection('tab', 'op', guest)).resolves.toEqual({
        opId: 'op',
        kind: 'error',
        reason: 'Frame unavailable'
      })
    }
  )

  it('waits for the replacement document before injecting the pending selection', async () => {
    const { guest, execute, state, events } = createGuest()
    state.loading = true
    execute.mockImplementation((script) => Promise.resolve(runInNewContext(script, { window: {} })))
    const controller = new BrowserGrabSessionController()
    const result = controller.awaitGrabSelection('tab', 'op', guest)
    expect(execute).not.toHaveBeenCalled()

    state.loading = false
    events.emit('did-stop-loading')

    await expect(result).resolves.toEqual({ opId: 'op', kind: 'error', reason: 'Grab not armed' })
    expect(events.listenerCount('did-stop-loading')).toBe(0)
    expect(controller.hasActiveGrabOp('tab')).toBe(false)
  })

  it.each([
    ['cancel', 'user'],
    ['timeout', 'timeout'],
    ['navigation', 'navigation'],
    ['destroy', 'evicted']
  ] as const)(
    'retires a pending document wait on %s without a late selection start',
    async (how, reason) => {
      vi.useFakeTimers()
      const { guest, execute, state, events } = createGuest()
      state.loading = true
      const controller = new BrowserGrabSessionController()
      const result = controller.awaitGrabSelection('tab', 'op', guest)
      expect(events.listenerCount('did-stop-loading')).toBe(1)

      if (how === 'cancel') {
        controller.cancelGrabOp('tab', 'user')
      }
      if (how === 'timeout') {
        await vi.advanceTimersByTimeAsync(120_000)
      }
      if (how === 'navigation') {
        events.emit('did-start-navigation', null, 'https://next.test', false, true)
      }
      if (how === 'destroy') {
        state.destroyed = true
        events.emit('destroyed')
      }

      await expect(result).resolves.toEqual({ opId: 'op', kind: 'cancelled', reason })
      expect(events.listenerCount('did-stop-loading')).toBe(0)
      state.loading = false
      events.emit('did-stop-loading')
      await Promise.resolve()
      expect(execute.mock.calls.some(([script]) => script.includes('value: await'))).toBe(false)
      expect(controller.hasActiveGrabOp('tab')).toBe(false)
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('keeps a replacement operation independent of the retired guest load', async () => {
    const old = createGuest()
    old.state.loading = true
    const controller = new BrowserGrabSessionController()
    const previous = controller.awaitGrabSelection('tab', 'old', old.guest)
    old.state.destroyed = true
    old.events.emit('destroyed')
    await expect(previous).resolves.toEqual({ opId: 'old', kind: 'cancelled', reason: 'evicted' })

    const next = createGuest()
    next.execute.mockReturnValueOnce(new Promise(() => {}))
    const successor = controller.awaitGrabSelection('tab', 'next', next.guest)
    old.events.emit('did-stop-loading')
    await Promise.resolve()
    expect(old.execute).not.toHaveBeenCalled()
    expect(controller.hasActiveGrabOp('tab')).toBe(true)
    controller.cancelGrabOp('tab', 'user')
    await expect(successor).resolves.toEqual({ opId: 'next', kind: 'cancelled', reason: 'user' })
  })

  it('handles rejection of best-effort teardown after cancellation', async () => {
    const { guest, execute } = createGuest()
    execute.mockReturnValueOnce(new Promise(() => {}))
    execute.mockRejectedValueOnce(new Error('Frame retired'))
    const controller = new BrowserGrabSessionController()
    const result = controller.awaitGrabSelection('tab', 'op', guest)
    controller.cancelGrabOp('tab', 'user')

    await expect(result).resolves.toEqual({ opId: 'op', kind: 'cancelled', reason: 'user' })
    expect(controller.hasActiveGrabOp('tab')).toBe(false)
    await Promise.resolve()
  })
})
