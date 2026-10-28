import { EventEmitter } from 'node:events'
import { ipcMain } from 'electron'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { requestBrowserTabRendererReply } from './browser-tab-renderer-reply'

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return { ipcMain: new EventEmitter() }
})

const CHANNEL = 'browser:tabCreateReply'

class Sender extends EventEmitter {
  dead = false
  send = vi.fn()
  isDestroyed(): boolean {
    return this.dead
  }
}

class Window extends EventEmitter {
  dead = false
  webContents = new Sender()
  isDestroyed(): boolean {
    return this.dead
  }
}

function request(win: Window) {
  return requestBrowserTabRendererReply<{ requestId: string; browserPageId?: string }>(
    win,
    CHANNEL,
    (requestId) => win.webContents.send('browser:requestTabCreate', { requestId }),
    'Tab creation timed out'
  )
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.runOnlyPendingTimers()
  vi.useRealTimers()
})

it.each([1, 10, 100])('retires %i overlapping requests on document loss', async (count) => {
  for (const event of ['did-navigate', 'render-process-gone', 'destroyed', 'closed']) {
    const win = new Window()
    const pending = Array.from({ length: count }, () =>
      request(win).then(
        () => 'resolved',
        (error: Error) => error.message
      )
    )
    expect(ipcMain.listenerCount(CHANNEL)).toBe(1)
    expect(win.listenerCount('closed')).toBe(1)
    if (event === 'closed') {
      win.emit(event)
    } else {
      win.webContents.emit(event)
    }
    expect(await Promise.all(pending)).toEqual(
      Array.from({ length: count }, () => 'Browser tab renderer went away')
    )
    expect(vi.getTimerCount()).toBe(0)
    expect(ipcMain.listenerCount(CHANNEL)).toBe(0)
    expect(win.eventNames()).toEqual([])
    expect(win.webContents.eventNames()).toEqual([])
  }
})

it('keeps sibling requests live and admits only their matching sender and request', async () => {
  const retired = new Window()
  const live = new Window()
  const first = request(retired).catch((error: Error) => error.message)
  const second = request(live)
  const reply = {
    requestId: live.webContents.send.mock.calls[0][1].requestId,
    browserPageId: 'page'
  }
  retired.webContents.emit('did-navigate')
  expect(await first).toBe('Browser tab renderer went away')
  ipcMain.emit(CHANNEL, { sender: retired.webContents }, reply)
  ipcMain.emit(CHANNEL, { sender: live.webContents }, { ...reply, requestId: 'foreign' })
  expect(vi.getTimerCount()).toBe(1)
  ipcMain.emit(CHANNEL, { sender: live.webContents }, reply)
  await expect(second).resolves.toEqual(reply)
  expect(vi.getTimerCount()).toBe(0)
  expect(ipcMain.listenerCount(CHANNEL)).toBe(0)
})

it('preserves same-document and blocked navigation and accepts a synchronous reply', async () => {
  const win = new Window()
  const first = request(win)
  win.webContents.emit('did-navigate-in-page')
  win.webContents.emit('will-navigate')
  win.webContents.emit('did-fail-provisional-load')
  expect(vi.getTimerCount()).toBe(1)
  const requestId = win.webContents.send.mock.calls[0][1].requestId
  ipcMain.emit(CHANNEL, { sender: win.webContents }, { requestId, browserPageId: 'first' })
  await expect(first).resolves.toEqual({ requestId, browserPageId: 'first' })
  const reply = { requestId: 'unset', browserPageId: 'next' }
  win.webContents.send.mockImplementation((_channel, payload: { requestId: string }) => {
    reply.requestId = payload.requestId
    ipcMain.emit(CHANNEL, { sender: win.webContents }, reply)
  })
  await expect(request(win)).resolves.toEqual(reply)
  expect(vi.getTimerCount()).toBe(0)
  expect(ipcMain.listenerCount(CHANNEL)).toBe(0)
})

it('keeps the live deadline and releases a failed send before it', async () => {
  const win = new Window()
  const timedOut = request(win).catch((error: Error) => error.message)
  await vi.advanceTimersByTimeAsync(9_999)
  expect(ipcMain.listenerCount(CHANNEL)).toBe(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(await timedOut).toBe('Tab creation timed out')
  expect(ipcMain.listenerCount(CHANNEL)).toBe(0)
  const failure = new Error('send failed')
  win.webContents.send.mockImplementation(() => {
    throw failure
  })
  await expect(request(win)).rejects.toBe(failure)
  expect(vi.getTimerCount()).toBe(0)
  expect(win.eventNames()).toEqual([])
  expect(win.webContents.eventNames()).toEqual([])
  expect(ipcMain.listenerCount(CHANNEL)).toBe(0)
})

it.each(['window', 'renderer'])('does not send through a destroyed %s', async (owner) => {
  const win = new Window()
  if (owner === 'window') {
    win.dead = true
  } else {
    win.webContents.dead = true
  }
  await expect(request(win)).rejects.toThrow('Browser tab renderer went away')
  expect(win.webContents.send).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
  expect(ipcMain.listenerCount(CHANNEL)).toBe(0)
})
