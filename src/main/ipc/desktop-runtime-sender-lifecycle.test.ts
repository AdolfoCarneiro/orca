import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import { DesktopRuntimeSenderLifecycle } from './desktop-runtime-sender-lifecycle'

function sender(id: number) {
  return Object.assign(new EventEmitter(), { id, mainFrame: { processId: 1, routingId: id } })
}

function failReplacement(owner: ReturnType<typeof sender>): void {
  owner.mainFrame.routingId++
  owner.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://orca.test/', true)
}

it.each([1, 10])('retires %s streams and the connection after a committed error', (count) => {
  const cleanup = vi.fn()
  const lifecycle = new DesktopRuntimeSenderLifecycle({
    cleanupSubscriptionsForConnection: cleanup
  })
  const owner = sender(1)
  const connection = lifecycle.connectionIdFor(owner)
  const controllers = Array.from({ length: count }, () => new AbortController())
  controllers.forEach((controller, i) =>
    lifecycle.subscriptionsFor(owner).set(`stream-${i}`, controller)
  )
  failReplacement(owner)
  expect(controllers.every((controller) => controller.signal.aborted)).toBe(true)
  expect(cleanup).toHaveBeenCalledExactlyOnceWith(connection)
  expect(lifecycle.existingSubscriptionsFor(owner)).toBeNull()
  expect(owner.eventNames()).toEqual([])
})

it('rearms successive documents while preserving a live sibling and new connection during abort', () => {
  const cleanup = vi.fn()
  const lifecycle = new DesktopRuntimeSenderLifecycle({
    cleanupSubscriptionsForConnection: cleanup
  })
  const owner = sender(1)
  const sibling = sender(2)
  const siblingController = new AbortController()
  const siblingConnection = lifecycle.connectionIdFor(sibling)
  lifecycle.subscriptionsFor(sibling).set('same-id', siblingController)
  for (let generation = 0; generation < 3; generation++) {
    const connection = lifecycle.connectionIdFor(owner)
    const old = new AbortController()
    const current = new AbortController()
    lifecycle.subscriptionsFor(owner).set('same-id', old)
    old.signal.addEventListener('abort', () =>
      lifecycle.subscriptionsFor(owner).set('same-id', current)
    )
    failReplacement(owner)
    expect(old.signal.aborted).toBe(true)
    expect(current.signal.aborted).toBe(false)
    expect(lifecycle.subscriptionsFor(owner).get('same-id')).toBe(current)
    expect(lifecycle.connectionIdFor(owner)).not.toBe(connection)
    expect(cleanup).toHaveBeenCalledWith(connection)
    expect(cleanup).not.toHaveBeenCalledWith(lifecycle.connectionIdFor(owner))
    expect(owner.listenerCount('did-fail-load')).toBe(1)
  }
  expect(siblingController.signal.aborted).toBe(false)
  expect(cleanup).not.toHaveBeenCalledWith(siblingConnection)
  owner.emit('destroyed')
  sibling.emit('destroyed')
  expect(owner.eventNames()).toEqual([])
  expect(sibling.eventNames()).toEqual([])
})

it('retires a replaced sender object without letting its late events retire the reused id', () => {
  const cleanup = vi.fn()
  const lifecycle = new DesktopRuntimeSenderLifecycle({
    cleanupSubscriptionsForConnection: cleanup
  })
  const old = sender(3)
  const current = sender(3)
  const oldController = new AbortController()
  lifecycle.subscriptionsFor(old).set('same-id', oldController)
  const currentController = new AbortController()
  lifecycle.subscriptionsFor(current).set('same-id', currentController)
  const connection = lifecycle.connectionIdFor(current)
  expect(oldController.signal.aborted).toBe(true)
  expect(old.eventNames()).toEqual([])
  old.emit('destroyed')
  failReplacement(old)
  expect(currentController.signal.aborted).toBe(false)
  expect(lifecycle.connectionIdFor(current)).toBe(connection)
  expect(cleanup).not.toHaveBeenCalledWith(connection)
  current.emit('destroyed')
})

it.each(['provisional', 'cancelled', 'invalid-url', 'subframe', 'same-document'])(
  'preserves a connection and stream after %s navigation',
  (kind) => {
    const cleanup = vi.fn()
    const lifecycle = new DesktopRuntimeSenderLifecycle({
      cleanupSubscriptionsForConnection: cleanup
    })
    const owner = sender(1)
    const controller = new AbortController()
    const connection = lifecycle.connectionIdFor(owner)
    lifecycle.subscriptionsFor(owner).set('stream', controller)
    if (kind === 'same-document') {
      owner.emit('did-navigate-in-page', {}, 'file:///same#hash', true)
    } else {
      owner.emit(
        'did-fail-load',
        {},
        kind === 'invalid-url' ? -300 : -3,
        'failed',
        'http://invalid',
        kind !== 'subframe'
      )
    }
    expect(controller.signal.aborted).toBe(false)
    expect(lifecycle.connectionIdFor(owner)).toBe(connection)
    expect(cleanup).not.toHaveBeenCalled()
    owner.emit('destroyed')
  }
)
