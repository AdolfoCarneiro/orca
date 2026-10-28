import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Rect = { x: number; y: number; width: number; height: number }

const electronMocks = vi.hoisted(() => {
  class FakeView {
    bounds: Rect = { x: 0, y: 0, width: 0, height: 0 }
    visible = true
    onDestroyed: (() => void) | null = null
    destroyed = false
    host = {
      // Like Electron, destruction finishes after close() returns.
      close: vi.fn(() => {
        setImmediate(() => this.destroy())
      }),
      isDestroyed: () => this.destroyed,
      once: vi.fn(),
      focus: vi.fn(),
      capturePage: vi.fn()
    }
    // Electron drops a view's contents once they are destroyed.
    get webContents(): typeof this.host | null {
      return this.destroyed ? null : this.host
    }
    destroy(): void {
      this.destroyed = true
      this.onDestroyed?.()
    }
    constructor() {
      electronMocks.views.push(this)
    }
    setVisible(visible: boolean): void {
      this.visible = visible
    }
    getVisible(): boolean {
      return this.visible
    }
    setBounds(bounds: Rect): void {
      this.bounds = bounds
    }
    getBounds(): Rect {
      return this.bounds
    }
  }
  const views: FakeView[] = []
  const state: { FakeView: typeof FakeView; views: FakeView[]; window: unknown } = {
    FakeView,
    views,
    window: null
  }
  return state
})

vi.mock('electron', () => ({
  WebContentsView: electronMocks.FakeView,
  BrowserWindow: { fromWebContents: () => electronMocks.window }
}))

import { BrowserGuestDevToolsDock } from './browser-guest-devtools-dock'

const GUEST_ID = 7

function createGuest(): EventEmitter & {
  id: number
  closeDevTools: ReturnType<typeof vi.fn>
  setDevToolsWebContents: ReturnType<typeof vi.fn>
} {
  const guest = Object.assign(new EventEmitter(), {
    id: GUEST_ID,
    hostWebContents: {},
    isDevToolsOpened: () => false,
    isDestroyed: () => false,
    closeDevTools: vi.fn(),
    openDevTools: vi.fn(),
    setDevToolsWebContents: vi.fn((devTools: unknown) => {
      // Electron reports a destroyed custom host as DevTools closing on the inspected page.
      const view = electronMocks.views.find((v) => v.host === devTools)
      if (view) {
        view.onDestroyed = () => guest.emit('devtools-closed')
      }
    })
  })
  return guest
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

function asGuest(guest: ReturnType<typeof createGuest>): Electron.WebContents {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake implements every guest member the dock calls.
  return guest as unknown as Electron.WebContents
}

async function openDock(onClosed = vi.fn()) {
  const dock = new BrowserGuestDevToolsDock()
  const guest = createGuest()
  await dock.open(asGuest(guest), onClosed)
  return { dock, guest, onClosed }
}

function captureFrame(view: (typeof electronMocks.views)[number]) {
  const image = { isEmpty: () => false, toJPEG: vi.fn(() => Buffer.from('frame')) }
  const capture = Promise.withResolvers<typeof image>()
  view.host.capturePage.mockReturnValue(capture.promise)
  return { image, finish: () => capture.resolve(image) }
}

describe('BrowserGuestDevToolsDock', () => {
  let children: unknown[]

  beforeEach(() => {
    electronMocks.views.length = 0
    children = []
    electronMocks.window = {
      isDestroyed: () => false,
      contentView: {
        addChildView: (view: unknown) => children.push(view),
        removeChildView: (view: unknown) => children.splice(children.indexOf(view), 1)
      },
      webContents: { getZoomFactor: () => 1 }
    }
  })

  it('reconnects a fresh frontend in the same place once a crashed page is back', async () => {
    const { dock, guest, onClosed } = await openDock()
    await dock.setBounds(GUEST_ID, { x: 0, y: 0, width: 100, height: 100 }, false)
    const [stale] = electronMocks.views

    guest.emit('render-process-gone')
    guest.emit('dom-ready')
    // The pane moved while the stale host was still detaching.
    await dock.setBounds(GUEST_ID, { x: 10, y: 20, width: 300, height: 200 }, false)
    await tick()

    const fresh = electronMocks.views[1]
    expect(stale.destroyed).toBe(true)
    expect(guest.setDevToolsWebContents).toHaveBeenLastCalledWith(fresh.host)
    expect(fresh.bounds).toEqual({ x: 10, y: 20, width: 300, height: 200 })
    expect(fresh.visible).toBe(true)
    expect(children).toEqual([fresh])
    expect(onClosed).not.toHaveBeenCalled()
    expect(dock.isDocked(GUEST_ID)).toBe(true)
  })

  it('keeps a view shown again while the snapshot for an overlay was still capturing', async () => {
    const { dock } = await openDock()
    await dock.setBounds(GUEST_ID, { x: 0, y: 0, width: 100, height: 100 }, false)
    const [view] = electronMocks.views
    const capture = captureFrame(view)

    const hidden = dock.setBounds(GUEST_ID, null, true)
    await dock.setBounds(GUEST_ID, { x: 0, y: 0, width: 120, height: 100 }, false)
    capture.finish()

    await expect(hidden).resolves.toBeNull()
    expect(capture.image.toJPEG).not.toHaveBeenCalled()
    expect(view.visible).toBe(true)
  })

  it.each(['closed', 'reopened'])(
    'drops a capture from a %s dock before encoding',
    async (state) => {
      const { dock, guest } = await openDock()
      await dock.setBounds(GUEST_ID, { x: 0, y: 0, width: 100, height: 100 }, false)
      const capture = captureFrame(electronMocks.views[0])
      const hidden = dock.setBounds(GUEST_ID, null, true)

      await dock.close(GUEST_ID)
      if (state === 'reopened') {
        await dock.open(asGuest(guest), vi.fn())
        await dock.setBounds(GUEST_ID, { x: 0, y: 0, width: 120, height: 100 }, false)
      }
      capture.finish()

      await expect(hidden).resolves.toBeNull()
      expect(capture.image.toJPEG).not.toHaveBeenCalled()
      if (state === 'reopened') {
        expect(electronMocks.views[1].visible).toBe(true)
      }
    }
  )

  it('drops a replaced frontend capture while preserving the current hide request', async () => {
    const { dock, guest, onClosed } = await openDock()
    const bounds = { x: 10, y: 20, width: 100, height: 100 }
    await dock.setBounds(GUEST_ID, bounds, false)
    const capture = captureFrame(electronMocks.views[0])
    const hidden = dock.setBounds(GUEST_ID, null, true)

    guest.emit('render-process-gone')
    guest.emit('dom-ready')
    await tick()
    capture.finish()

    await expect(hidden).resolves.toBeNull()
    expect(capture.image.toJPEG).not.toHaveBeenCalled()
    const fresh = electronMocks.views[1]
    expect(fresh.bounds).toEqual(bounds)
    expect(fresh.visible).toBe(false)
    expect(children).toEqual([fresh])
    expect(onClosed).not.toHaveBeenCalled()
    expect(dock.isDocked(GUEST_ID)).toBe(true)
  })

  it('returns the current frame and hides its view', async () => {
    const { dock } = await openDock()
    await dock.setBounds(GUEST_ID, { x: 0, y: 0, width: 100, height: 100 }, false)
    const [view] = electronMocks.views
    const capture = captureFrame(view)
    const hidden = dock.setBounds(GUEST_ID, null, true)
    capture.finish()

    await expect(hidden).resolves.toBe(
      `data:image/jpeg;base64,${Buffer.from('frame').toString('base64')}`
    )
    expect(capture.image.toJPEG).toHaveBeenCalledExactlyOnceWith(85)
    expect(view.visible).toBe(false)
  })

  it('still hides the view when the snapshot capture fails', async () => {
    const { dock } = await openDock()
    await dock.setBounds(GUEST_ID, { x: 0, y: 0, width: 100, height: 100 }, false)
    const [view] = electronMocks.views
    view.host.capturePage.mockRejectedValue(new Error('Object has been destroyed'))

    await expect(dock.setBounds(GUEST_ID, null, true)).resolves.toBeNull()
    expect(view.visible).toBe(false)
  })

  it('closes by destroying its host and reopens only once Electron has let go of it', async () => {
    const { dock, guest, onClosed } = await openDock()

    void dock.close(GUEST_ID)
    const reopened = dock.open(asGuest(guest), vi.fn())
    expect(guest.setDevToolsWebContents).toHaveBeenCalledTimes(1)

    await expect(reopened).resolves.toBe(true)
    expect(guest.setDevToolsWebContents).toHaveBeenCalledTimes(2)
    expect(electronMocks.views[0].destroyed).toBe(true)
    // closeDevTools() would leave a custom host attached and frozen.
    expect(guest.closeDevTools).not.toHaveBeenCalled()
    expect(onClosed).toHaveBeenCalledTimes(1)
  })

  it('reports the close when its host was destroyed underneath it', async () => {
    const { dock, onClosed } = await openDock()

    electronMocks.views[0].destroy()

    expect(onClosed).toHaveBeenCalledTimes(1)
    expect(dock.isDocked(GUEST_ID)).toBe(false)
  })
})
