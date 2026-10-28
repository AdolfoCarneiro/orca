import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import {
  abortWhenRendererGone,
  RENDERER_GONE_MESSAGE,
  type RendererLifetimeSender
} from './renderer-lifetime-abort'

function fakeSender(): RendererLifetimeSender & EventEmitter {
  return new EventEmitter()
}

describe('abortWhenRendererGone', () => {
  it.each(['processId', 'routingId'] as const)(
    'retires a committed error document when the primary %s changes',
    (field) => {
      const mainFrame = { processId: 1, routingId: 2 }
      const sender = Object.assign(fakeSender(), { mainFrame })
      const { signal } = abortWhenRendererGone(sender)
      mainFrame[field]++
      sender.emit('did-fail-load', {}, -2, 'ERR_FAILED', 'https://orca.test/', true)
      expect(signal.aborted).toBe(true)
      expect(sender.eventNames()).toEqual([])
    }
  )

  it('preserves the owner on invalid-URL failures and ignores failed subframes', () => {
    const mainFrame = { processId: 1, routingId: 2 }
    const sender = Object.assign(fakeSender(), { mainFrame })
    const lifetime = abortWhenRendererGone(sender)
    sender.emit('did-fail-load', {}, -300, 'ERR_INVALID_URL', 'http://[', true)
    expect(lifetime.signal.aborted).toBe(false)
    mainFrame.routingId++
    sender.emit('did-fail-load', {}, -2, 'ERR_FAILED', 'https://orca.test/child', false)
    expect(lifetime.signal.aborted).toBe(false)
    lifetime.dispose()
    expect(sender.eventNames()).toEqual([])
  })

  it('shares error-page observation and permits fresh successor lifetimes', () => {
    const mainFrame = { processId: 1, routingId: 2 }
    const sender = Object.assign(fakeSender(), { mainFrame })
    const lifetimes = Array.from({ length: 25 }, () => abortWhenRendererGone(sender))
    expect(sender.listenerCount('did-fail-load')).toBe(1)
    lifetimes[0].dispose()
    mainFrame.routingId++
    sender.emit('did-fail-load', {}, -2, 'ERR_FAILED', 'https://orca.test/', true)
    expect(lifetimes[0].signal.aborted).toBe(false)
    expect(lifetimes.slice(1).every(({ signal }) => signal.aborted)).toBe(true)
    expect(sender.eventNames()).toEqual([])
    const successor = abortWhenRendererGone(sender)
    sender.emit('did-fail-load', {}, -300, 'ERR_INVALID_URL', 'http://[', true)
    expect(successor.signal.aborted).toBe(false)
    successor.dispose()
    expect(sender.eventNames()).toEqual([])
  })

  it.each(['initial', 'later'])(
    'keeps event-based retirement when frame metadata is inaccessible at the %s read',
    (stage) => {
      const sender = fakeSender()
      let unavailable = stage === 'initial'
      Object.defineProperty(sender, 'mainFrame', {
        get: () => {
          if (unavailable) {
            throw new Error('Object has been destroyed')
          }
          return { processId: 1, routingId: 2 }
        }
      })
      const lifetime = abortWhenRendererGone(sender)
      unavailable = true
      expect(() =>
        sender.emit('did-fail-load', {}, -2, 'ERR_FAILED', 'https://orca.test/', true)
      ).not.toThrow()
      expect(lifetime.signal.aborted).toBe(false)
      sender.emit('destroyed')
      expect(lifetime.signal.aborted).toBe(true)
      expect(sender.eventNames()).toEqual([])
    }
  )

  it('aborts when the renderer is destroyed', () => {
    const sender = fakeSender()
    const { signal } = abortWhenRendererGone(sender)

    expect(signal.aborted).toBe(false)
    sender.emit('destroyed')

    expect(signal.aborted).toBe(true)
    expect(String(signal.reason)).toContain(RENDERER_GONE_MESSAGE)
  })

  it('aborts when the render process is gone', () => {
    const sender = fakeSender()
    const { signal } = abortWhenRendererGone(sender)

    sender.emit('render-process-gone')

    expect(signal.aborted).toBe(true)
  })

  it('aborts once a reload has replaced the document, not on in-app route changes', () => {
    const sender = fakeSender()
    const { signal } = abortWhenRendererGone(sender)

    sender.emit('did-start-navigation', {
      isMainFrame: true,
      isSameDocument: true,
      url: 'file:///app#x'
    })
    sender.emit('did-navigate-in-page', 'file:///app#x')
    expect(signal.aborted).toBe(false)

    sender.emit('did-start-navigation', {
      isMainFrame: true,
      isSameDocument: false,
      url: 'file:///app'
    })
    sender.emit('did-navigate', 'file:///app', 200, 'OK')
    expect(signal.aborted).toBe(true)
  })

  it('ignores a main-frame navigation that starts but is blocked before it commits', () => {
    // did-start-navigation precedes blocked external navigation; the surviving document must keep its work.
    const sender = fakeSender()
    const { signal } = abortWhenRendererGone(sender)

    sender.emit('did-start-navigation', {
      isMainFrame: true,
      isSameDocument: false,
      url: 'https://example.invalid/'
    })
    sender.emit('will-navigate', { defaultPrevented: true }, 'https://example.invalid/')
    sender.emit('did-start-navigation', {
      isMainFrame: true,
      isSameDocument: false,
      url: 'file:///Users/me/dropped.png'
    })
    sender.emit('will-navigate', { defaultPrevented: true }, 'file:///Users/me/dropped.png')

    expect(signal.aborted).toBe(false)
  })

  it('leaves no listeners on a long-lived renderer once disposed', () => {
    const sender = fakeSender()
    const { dispose } = abortWhenRendererGone(sender)

    expect(sender.listenerCount('destroyed')).toBe(1)
    dispose()
    dispose()

    expect(sender.listenerCount('destroyed')).toBe(0)
    expect(sender.listenerCount('render-process-gone')).toBe(0)
    expect(sender.listenerCount('did-navigate')).toBe(0)
  })

  it('keeps one listener per event however many lifetimes overlap on a renderer', () => {
    const sender = fakeSender()
    const lifetimes = Array.from({ length: 25 }, () => abortWhenRendererGone(sender))

    for (const event of ['destroyed', 'render-process-gone', 'did-navigate']) {
      expect(sender.listenerCount(event)).toBe(1)
    }
    lifetimes[0].dispose()
    sender.emit('did-navigate', 'file:///app', 200, 'OK')

    expect(lifetimes[0].signal.aborted).toBe(false)
    expect(lifetimes.slice(1).every(({ signal }) => signal.aborted)).toBe(true)
    expect(sender.eventNames()).toEqual([])
  })
})
