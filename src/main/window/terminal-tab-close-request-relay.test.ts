import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ipcEmitter = new EventEmitter()
const ipcMainMock = {
  on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
    ipcEmitter.on(channel, listener)
  }),
  removeListener: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
    ipcEmitter.removeListener(channel, listener)
  })
}

vi.mock('electron', () => ({ ipcMain: ipcMainMock }))

describe('requestTerminalTabCloseFromRenderer', () => {
  beforeEach(() => {
    ipcEmitter.removeAllListeners()
    ipcMainMock.on.mockClear()
    ipcMainMock.removeListener.mockClear()
  })

  it('waits for the targeted renderer durability acknowledgement', async () => {
    const { requestTerminalTabCloseFromRenderer } =
      await import('./terminal-tab-close-request-relay')
    const webContents = { isDestroyed: () => false, send: vi.fn() }
    const otherWebContents = {}
    const mainWindow = { isDestroyed: () => false, webContents }
    const pending = requestTerminalTabCloseFromRenderer(mainWindow as never, 'tab-1', {
      localPtyTeardownOwnedExternally: true,
      force: true
    })
    const request = webContents.send.mock.calls[0]?.[1] as {
      requestId: string
      tabId: string
      localPtyTeardownOwnedExternally?: boolean
      force?: boolean
    }

    expect(request.tabId).toBe('tab-1')
    expect(request.localPtyTeardownOwnedExternally).toBe(true)
    expect(request.force).toBe(true)
    ipcEmitter.emit(
      'ui:terminalTabCloseResponse',
      { sender: otherWebContents },
      { requestId: request.requestId }
    )
    let settled = false
    void pending.finally(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    ipcEmitter.emit(
      'ui:terminalTabCloseResponse',
      { sender: webContents },
      { requestId: request.requestId }
    )
    await expect(pending).resolves.toBeUndefined()
  })

  it('propagates renderer cancellation instead of reporting success', async () => {
    const { requestTerminalTabCloseFromRenderer } =
      await import('./terminal-tab-close-request-relay')
    const webContents = { isDestroyed: () => false, send: vi.fn() }
    const pending = requestTerminalTabCloseFromRenderer(
      { isDestroyed: () => false, webContents } as never,
      'tab-pinned'
    )
    const request = webContents.send.mock.calls[0]?.[1] as { requestId: string }

    ipcEmitter.emit(
      'ui:terminalTabCloseResponse',
      { sender: webContents },
      { requestId: request.requestId, error: 'terminal_tab_pinned' }
    )

    await expect(pending).rejects.toThrow('terminal_tab_pinned')
  })

  it('rejects and cleans up when the BrowserWindow closes and webContents becomes unavailable', async () => {
    const { requestTerminalTabCloseFromRenderer } =
      await import('./terminal-tab-close-request-relay')
    const webContents = Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      send: vi.fn()
    })
    let windowClosed = false
    const mainWindow = Object.assign(new EventEmitter(), {
      isDestroyed: () => false
    })
    Object.defineProperty(mainWindow, 'webContents', {
      get: () => {
        if (windowClosed) {
          throw new Error('webContents unavailable after close')
        }
        return webContents
      }
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the EventEmitter test double implements the BrowserWindow events used by this test.
    const pending = requestTerminalTabCloseFromRenderer(mainWindow as never, 'tab-closed')
    expect(ipcEmitter.listenerCount('ui:terminalTabCloseResponse')).toBe(1)

    windowClosed = true
    mainWindow.emit('closed')

    await expect(pending).rejects.toThrow('renderer_unavailable')
    expect(ipcEmitter.listenerCount('ui:terminalTabCloseResponse')).toBe(0)
    expect(webContents.listenerCount('destroyed')).toBe(0)
    expect(webContents.listenerCount('render-process-gone')).toBe(0)
  })

  it('shares one lifecycle listener across overlapping close requests', async () => {
    const { requestTerminalTabCloseFromRenderer } =
      await import('./terminal-tab-close-request-relay')
    const webContents = Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      send: vi.fn()
    })
    const mainWindow = Object.assign(new EventEmitter(), { isDestroyed: () => false, webContents })
    const pending = Array.from({ length: 15 }, (_, index) =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the EventEmitter double implements the BrowserWindow members the relay uses.
      requestTerminalTabCloseFromRenderer(mainWindow as never, `tab-${index}`)
    )

    expect(ipcEmitter.listenerCount('ui:terminalTabCloseResponse')).toBe(1)
    expect(mainWindow.listenerCount('closed')).toBe(1)
    expect(webContents.listenerCount('destroyed')).toBe(1)
    expect(webContents.listenerCount('render-process-gone')).toBe(1)
    webContents.emit('render-process-gone')

    await Promise.all(
      pending.map((request) => expect(request).rejects.toThrow('renderer_unavailable'))
    )
    expect(mainWindow.eventNames()).toEqual([])
    expect(webContents.eventNames()).toEqual([])
    expect(ipcEmitter.listenerCount('ui:terminalTabCloseResponse')).toBe(0)
  })

  it.each([1, 10, 100])(
    'retires %i requests with a replaced document while another window can acknowledge',
    async (count) => {
      vi.useFakeTimers()
      try {
        const { requestTerminalTabCloseFromRenderer } =
          await import('./terminal-tab-close-request-relay')
        const contents = () =>
          Object.assign(new EventEmitter(), {
            isDestroyed: () => false,
            send: vi.fn((_channel: string, _request: { requestId: string }) => {})
          })
        const first = contents()
        const sibling = contents()
        const firstWindow = Object.assign(new EventEmitter(), {
          isDestroyed: () => false,
          webContents: first
        })
        const siblingWindow = Object.assign(new EventEmitter(), {
          isDestroyed: () => false,
          webContents: sibling
        })
        const pending = Array.from({ length: count }, (_, index) =>
          // SAFETY: the EventEmitter double supplies the BrowserWindow members used by the relay.
          requestTerminalTabCloseFromRenderer(firstWindow as never, `tab-${index}`).catch(
            (error: unknown) => (error instanceof Error ? error.message : String(error))
          )
        )
        // SAFETY: the EventEmitter double supplies the BrowserWindow members used by the relay.
        const survivor = requestTerminalTabCloseFromRenderer(siblingWindow as never, 'sibling')
        expect(vi.getTimerCount()).toBe(count + 1)
        first.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
        first.emit('did-navigate-in-page', {}, 'https://orca.test/#fragment', true)
        first.emit('did-frame-navigate', {}, 'https://orca.test/frame', 200, 'OK', false)
        expect(vi.getTimerCount()).toBe(count + 1)

        first.emit('did-navigate', {}, 'https://orca.test/replaced', 200, 'OK')
        expect(vi.getTimerCount()).toBe(1)
        await expect(Promise.all(pending)).resolves.toEqual(
          Array(count).fill('renderer_unavailable')
        )
        expect(first.eventNames()).toEqual([])
        expect(firstWindow.eventNames()).toEqual([])
        expect(vi.getTimerCount()).toBe(1)
        const request = sibling.send.mock.calls[0][1]
        ipcEmitter.emit(
          'ui:terminalTabCloseResponse',
          { sender: sibling },
          { requestId: request.requestId }
        )
        await expect(survivor).resolves.toBeUndefined()
        expect(sibling.eventNames()).toEqual([])
        expect(siblingWindow.eventNames()).toEqual([])
        expect(ipcEmitter.listenerCount('ui:terminalTabCloseResponse')).toBe(0)
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        vi.useRealTimers()
      }
    }
  )
})
