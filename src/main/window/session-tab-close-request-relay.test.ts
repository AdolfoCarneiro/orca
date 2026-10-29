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

function createMainWindow() {
  const webContents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    isLoadingMainFrame: vi.fn(() => true),
    send: vi.fn()
  })
  const mainWindow = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    webContents
  })
  return { mainWindow, webContents }
}

describe('requestSessionTabCloseFromRenderer', () => {
  beforeEach(() => {
    vi.useRealTimers()
    ipcEmitter.removeAllListeners()
    ipcMainMock.on.mockClear()
    ipcMainMock.removeListener.mockClear()
  })

  it('waits for the targeted renderer acknowledgement', async () => {
    const { requestSessionTabCloseFromRenderer } = await import('./session-tab-close-request-relay')
    const { mainWindow, webContents } = createMainWindow()
    const pending = requestSessionTabCloseFromRenderer(mainWindow as never, 'tab-1', 'wt-1')
    const request = webContents.send.mock.calls[0]?.[1] as {
      requestId: string
      tabId: string
      worktreeId: string
      expiresAt: number
    }

    expect(request).toMatchObject({ tabId: 'tab-1', worktreeId: 'wt-1' })
    expect(request.expiresAt).toBeGreaterThan(Date.now())
    ipcEmitter.emit('ui:sessionTabCloseResponse', { sender: {} }, { requestId: request.requestId })
    let settled = false
    void pending.finally(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    ipcEmitter.emit(
      'ui:sessionTabCloseResponse',
      { sender: webContents },
      { requestId: request.requestId }
    )
    await expect(pending).resolves.toBeUndefined()
  })

  it('propagates renderer cancellation', async () => {
    const { requestSessionTabCloseFromRenderer } = await import('./session-tab-close-request-relay')
    const { mainWindow, webContents } = createMainWindow()
    const pending = requestSessionTabCloseFromRenderer(mainWindow as never, 'tab-pinned', 'wt-1')
    const request = webContents.send.mock.calls[0]?.[1] as { requestId: string }

    ipcEmitter.emit(
      'ui:sessionTabCloseResponse',
      { sender: webContents },
      { requestId: request.requestId, error: 'session_tab_close_canceled' }
    )

    await expect(pending).rejects.toThrow('session_tab_close_canceled')
  })

  it.each([1, 10])('preserves %s close requests during subframe loading', async (count) => {
    vi.useFakeTimers()
    const { requestSessionTabCloseFromRenderer } = await import('./session-tab-close-request-relay')
    const { mainWindow, webContents } = createMainWindow()
    const outcomes: string[] = []
    const pending = Array.from({ length: count }, (_, index) =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the double implements all BrowserWindow members used by this relay.
      requestSessionTabCloseFromRenderer(mainWindow as never, `tab-${index}`, 'wt-1').then(
        () => outcomes.push('ack'),
        (error: Error) => outcomes.push(error.message)
      )
    )

    webContents.isLoadingMainFrame.mockReturnValue(false)
    webContents.emit('did-start-loading')
    webContents.emit('did-start-loading')
    await Promise.resolve()
    await Promise.resolve()
    expect(outcomes).toEqual([])
    expect(vi.getTimerCount()).toBe(count)
    expect(webContents.listenerCount('did-start-loading')).toBe(1)

    for (const [, request] of webContents.send.mock.calls) {
      ipcEmitter.emit('ui:sessionTabCloseResponse', { sender: webContents }, request)
    }
    await Promise.all(pending)
    expect(outcomes).toEqual(Array.from({ length: count }, () => 'ack'))
    expect(vi.getTimerCount()).toBe(0)
    expect(mainWindow.eventNames()).toEqual([])
    expect(webContents.eventNames()).toEqual([])
    expect(ipcEmitter.listenerCount('ui:sessionTabCloseResponse')).toBe(0)
  })

  it('still rejects on main-frame loading after ignoring subframe loading', async () => {
    vi.useFakeTimers()
    const { requestSessionTabCloseFromRenderer } = await import('./session-tab-close-request-relay')
    const { mainWindow, webContents } = createMainWindow()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the double implements all BrowserWindow members used by this relay.
    const pending = requestSessionTabCloseFromRenderer(mainWindow as never, 'tab-1', 'wt-1').then(
      () => 'ack',
      (error: Error) => error.message
    )
    webContents.isLoadingMainFrame.mockReturnValue(false)
    webContents.emit('did-start-loading')
    expect(vi.getTimerCount()).toBe(1)
    webContents.isLoadingMainFrame.mockReturnValue(true)
    webContents.emit('did-start-loading')
    await expect(pending).resolves.toBe('renderer_unavailable')
    expect(vi.getTimerCount()).toBe(0)
    expect(mainWindow.eventNames()).toEqual([])
    expect(webContents.eventNames()).toEqual([])
    expect(ipcEmitter.listenerCount('ui:sessionTabCloseResponse')).toBe(0)
  })

  it('rejects and releases listeners when the target window closes', async () => {
    const { requestSessionTabCloseFromRenderer } = await import('./session-tab-close-request-relay')
    const { mainWindow, webContents } = createMainWindow()
    const pending = requestSessionTabCloseFromRenderer(mainWindow as never, 'tab-1', 'wt-1')

    mainWindow.emit('closed')

    await expect(pending).rejects.toThrow('renderer_unavailable')
    expect(ipcEmitter.listenerCount('ui:sessionTabCloseResponse')).toBe(0)
    expect(webContents.listenerCount('destroyed')).toBe(0)
  })

  it.each(['destroyed', 'render-process-gone', 'did-start-loading'])(
    'rejects when web contents emits %s',
    async (eventName) => {
      const { requestSessionTabCloseFromRenderer } =
        await import('./session-tab-close-request-relay')
      const { mainWindow, webContents } = createMainWindow()
      const pending = requestSessionTabCloseFromRenderer(mainWindow as never, 'tab-1', 'wt-1')

      webContents.emit(eventName)

      await expect(pending).rejects.toThrow('renderer_unavailable')
      expect(ipcEmitter.listenerCount('ui:sessionTabCloseResponse')).toBe(0)
    }
  )

  it('times out after the renderer confirmation lease and response grace', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const { requestSessionTabCloseFromRenderer } = await import('./session-tab-close-request-relay')
    const { mainWindow, webContents } = createMainWindow()
    const pending = requestSessionTabCloseFromRenderer(mainWindow as never, 'tab-1', 'wt-1')
    const request = webContents.send.mock.calls[0]?.[1] as { expiresAt: number }
    const rejection = expect(pending).rejects.toThrow('session_tab_close_timeout')

    await vi.advanceTimersByTimeAsync(request.expiresAt - Date.now() + 5_000)

    await rejection
    expect(ipcEmitter.listenerCount('ui:sessionTabCloseResponse')).toBe(0)
  })

  it('shares one lifecycle listener across overlapping close requests', async () => {
    const { requestSessionTabCloseFromRenderer } = await import('./session-tab-close-request-relay')
    const { mainWindow, webContents } = createMainWindow()
    const pending = Array.from({ length: 15 }, (_, index) =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the EventEmitter double implements the BrowserWindow members the relay uses.
      requestSessionTabCloseFromRenderer(mainWindow as never, `tab-${index}`, 'wt-1')
    )

    expect(ipcEmitter.listenerCount('ui:sessionTabCloseResponse')).toBe(1)
    expect(mainWindow.listenerCount('closed')).toBe(1)
    for (const event of ['destroyed', 'render-process-gone', 'did-start-loading']) {
      expect(webContents.listenerCount(event)).toBe(1)
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the relay sends only session tab close requests on this double.
    const requests = webContents.send.mock.calls as [string, { requestId: string }][]
    for (const [, request] of requests) {
      ipcEmitter.emit(
        'ui:sessionTabCloseResponse',
        { sender: webContents },
        { requestId: request.requestId }
      )
    }

    await Promise.all(pending)
    expect(mainWindow.eventNames()).toEqual([])
    expect(webContents.eventNames()).toEqual([])
    expect(ipcEmitter.listenerCount('ui:sessionTabCloseResponse')).toBe(0)
  })

  it.each([
    ['window', 'closed'],
    ['webContents', 'destroyed'],
    ['webContents', 'did-start-loading']
  ] as const)(
    'rejects both overlapping requests on one %s %s and returns to baseline listeners',
    async (target, eventName) => {
      const { requestSessionTabCloseFromRenderer } =
        await import('./session-tab-close-request-relay')
      const { mainWindow, webContents } = createMainWindow()
      const baseline = {
        window: mainWindow.eventNames(),
        webContents: webContents.eventNames(),
        ipc: ipcEmitter.listenerCount('ui:sessionTabCloseResponse')
      }
      const pending = ['tab-1', 'tab-2'].map((tabId) =>
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the EventEmitter double implements the BrowserWindow members the relay uses.
        requestSessionTabCloseFromRenderer(mainWindow as never, tabId, 'wt-1')
      )

      ;(target === 'window' ? mainWindow : webContents).emit(eventName)

      await Promise.all(
        pending.map((request) => expect(request).rejects.toThrow('renderer_unavailable'))
      )
      expect(mainWindow.eventNames()).toEqual(baseline.window)
      expect(webContents.eventNames()).toEqual(baseline.webContents)
      expect(ipcEmitter.listenerCount('ui:sessionTabCloseResponse')).toBe(baseline.ipc)
    }
  )
})
