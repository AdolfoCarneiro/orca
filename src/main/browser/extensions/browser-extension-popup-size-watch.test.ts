import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => {
  const channels: { port1: Port; port2: Port }[] = []
  return { channels }
})

class Port extends EventEmitter {
  close = vi.fn()
  start = vi.fn()
}

vi.mock('electron', () => ({
  MessageChannelMain: class {
    port1 = new Port()
    port2 = new Port()
    constructor() {
      native.channels.push(this)
    }
  }
}))

const { watchBrowserExtensionPopupSize } = await import('./browser-extension-popup-size-watch')

function fixture() {
  let destroyed = false
  const sender = Object.assign(new EventEmitter(), {
    isDestroyed: () => destroyed,
    send: vi.fn(),
    mainFrame: { postMessage: vi.fn() }
  })
  const apply = vi.fn()
  const ready: boolean[] = []
  // SAFETY: the watcher only uses the lifecycle, mainFrame transfer and send methods provided here.
  const contents = sender as unknown as Electron.WebContents
  const dispose = watchBrowserExtensionPopupSize(contents, {
    apply,
    setReady: (value) => ready.push(value)
  })
  return {
    sender,
    apply,
    ready,
    dispose,
    destroy: () => {
      destroyed = true
      sender.emit('destroyed')
    }
  }
}

beforeEach(() => {
  native.channels.length = 0
})

describe('popup document sizing ownership', () => {
  it('invalidates readiness on replacement and ignores predecessor reports and teardown', () => {
    const f = fixture()
    f.sender.emit('dom-ready')
    const first = native.channels[0]
    const staleMessage = first.port1.listeners('message')[0]
    const staleClose = first.port1.listeners('close')[0]
    first.port1.emit('message', { data: { width: 120, height: 70 } })
    expect(f.ready.at(-1)).toBe(true)
    f.sender.emit('did-navigate')
    expect(f.ready.at(-1)).toBe(false)
    f.sender.emit('dom-ready')
    staleMessage({ data: { width: 999, height: 999 } })
    staleClose()
    expect(f.ready.at(-1)).toBe(false)
    expect(f.apply).toHaveBeenCalledTimes(1)
    native.channels[1].port1.emit('message', { data: { width: 90, height: 40 } })
    expect(f.apply).toHaveBeenLastCalledWith({ width: 90, height: 40 })
    expect(f.ready.at(-1)).toBe(true)
    f.dispose()
    expect(f.sender.eventNames()).toEqual([])
  })

  it('keeps replacement startup pending when the predecessor never reports', () => {
    const f = fixture()
    f.sender.emit('dom-ready')
    const staleMessage = native.channels[0].port1.listeners('message')[0]
    f.sender.emit('did-navigate')
    f.sender.emit('dom-ready')
    staleMessage({ data: null })
    expect(f.ready).not.toContain(true)
    native.channels[1].port1.emit('message', { data: { width: 80, height: 50 } })
    expect(f.ready.at(-1)).toBe(true)
    f.destroy()
    expect(f.sender.eventNames()).toEqual([])
  })

  it('uses the initial-bounds fallback for a current transfer failure, then measures a reload', () => {
    const f = fixture()
    f.sender.mainFrame.postMessage.mockImplementationOnce(() => {
      throw new Error('Frame detached')
    })
    f.sender.emit('dom-ready')
    expect(f.ready.at(-1)).toBe(true)
    expect(f.apply).not.toHaveBeenCalled()
    expect(native.channels[0].port1.close).toHaveBeenCalledTimes(1)
    expect(native.channels[0].port2.close).toHaveBeenCalledTimes(1)
    f.sender.emit('did-navigate')
    expect(f.ready.at(-1)).toBe(false)
    f.sender.emit('dom-ready')
    native.channels[1].port1.emit('message', { data: { width: 100, height: 60 } })
    expect(f.apply).toHaveBeenCalledWith({ width: 100, height: 60 })
    f.dispose()
    expect(f.sender.eventNames()).toEqual([])
  })

  it('accepts measurement failure only from the current document and releases it on close', () => {
    const f = fixture()
    f.sender.emit('dom-ready')
    native.channels[0].port1.emit('message', { data: { width: Number.NaN, height: 70 } })
    expect(f.ready).not.toContain(true)
    native.channels[0].port1.emit('message', { data: null })
    expect(f.ready.at(-1)).toBe(true)
    expect(f.apply).not.toHaveBeenCalled()
    f.destroy()
    f.dispose()
    expect(native.channels[0].port1.close).toHaveBeenCalledTimes(1)
    expect(f.sender.eventNames()).toEqual([])
  })

  it('retires a crashed document, ignores late reports and supports a healthy reload', () => {
    const f = fixture()
    f.sender.emit('dom-ready')
    const staleMessage = native.channels[0].port1.listeners('message')[0]
    f.sender.emit('render-process-gone')
    staleMessage({ data: { width: 999, height: 999 } })
    expect(f.ready.at(-1)).toBe(false)
    expect(f.apply).not.toHaveBeenCalled()
    f.sender.emit('dom-ready')
    native.channels[1].port1.emit('message', { data: { width: 160, height: 90 } })
    expect(f.apply).toHaveBeenCalledWith({ width: 160, height: 90 })
    f.destroy()
    expect(f.sender.eventNames()).toEqual([])
  })

  it('stops before the first report and makes repeated disposal harmless', () => {
    const f = fixture()
    f.sender.emit('dom-ready')
    const staleMessage = native.channels[0].port1.listeners('message')[0]
    f.dispose()
    f.dispose()
    staleMessage({ data: { width: 120, height: 70 } })
    f.sender.emit('dom-ready')
    expect(f.apply).not.toHaveBeenCalled()
    expect(f.ready).not.toContain(true)
    expect(native.channels).toHaveLength(1)
    expect(native.channels[0].port1.close).toHaveBeenCalledTimes(1)
    expect(f.sender.eventNames()).toEqual([])
  })
})
