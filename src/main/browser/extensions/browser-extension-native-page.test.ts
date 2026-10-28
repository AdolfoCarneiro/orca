import type { EventEmitter } from 'node:events'
import { session } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runBrowserExtensionNativePage } from './browser-extension-native-page'

type NativePageWindow = {
  webContents: EventEmitter & { mainFrame: object; send: ReturnType<typeof vi.fn> }
  destroy: ReturnType<typeof vi.fn>
}
const mocks = vi.hoisted(() => ({
  windows: new Array<NativePageWindow>(),
  preloadAvailable: true,
  load: async (): Promise<void> => {}
}))
vi.mock('node:fs', () => ({ existsSync: () => mocks.preloadAvailable }))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    session: { fromPartition: () => ({}) },
    BrowserWindow: class {
      webContents = Object.assign(new EventEmitter(), { mainFrame: {}, send: vi.fn() })
      loadURL = () => mocks.load()
      destroy = vi.fn()
      constructor() {
        mocks.windows.push(this)
      }
    }
  }
})

const options = {
  session: session.fromPartition('native-page-test'),
  extensionId: 'a'.repeat(32),
  code: 'var result = undefined; ({ result, array: [undefined] })',
  timeoutMs: 500
}
const replyChannel = 'browser-extension-native-page:reply'
function windowForOperation(): NativePageWindow {
  const window = mocks.windows.at(-1)
  if (!window) {
    throw new Error('Native window was not created')
  }
  return window
}
beforeEach(() => {
  mocks.windows.length = 0
  mocks.preloadAvailable = true
  mocks.load = async () => {}
})
afterEach(() => vi.useRealTimers())

describe('native extension page reply ownership', () => {
  it('accepts only its main-frame reply and preserves undefined members', async () => {
    const pending = runBrowserExtensionNativePage(options)
    const window = windowForOperation()
    await Promise.resolve()
    expect(window.webContents.send).toHaveBeenCalledWith(
      'browser-extension-native-page:execute',
      options.code
    )
    const value = { result: undefined, array: [undefined] }
    window.webContents.emit('ipc-message', { senderFrame: {} }, replyChannel, null, 'foreign')
    window.webContents.emit(
      'ipc-message',
      { senderFrame: window.webContents.mainFrame },
      'foreign-channel',
      null,
      'foreign'
    )
    window.webContents.emit(
      'ipc-message',
      { senderFrame: window.webContents.mainFrame },
      replyChannel,
      null,
      value
    )
    await expect(pending).resolves.toBe(value)
    expect(window.webContents.listenerCount('ipc-message')).toBe(0)
    expect(window.destroy).toHaveBeenCalledOnce()
  })

  it('releases each scoped reply listener when repeated operations are cancelled', async () => {
    for (let index = 0; index < 10; index++) {
      const controller = new AbortController()
      const pending = runBrowserExtensionNativePage({ ...options, signal: controller.signal })
      const window = windowForOperation()
      await Promise.resolve()
      expect(window.webContents.listenerCount('ipc-message')).toBe(1)
      controller.abort()
      await expect(pending).rejects.toThrow('Extension context was unloaded')
      expect(window.webContents.listenerCount('ipc-message')).toBe(0)
      expect(window.destroy).toHaveBeenCalledOnce()
    }
  })

  it('releases the listener and window when native execution never replies', async () => {
    vi.useFakeTimers()
    const pending = runBrowserExtensionNativePage(options)
    const rejected = expect(pending).rejects.toThrow('Native extension operation timed out')
    await vi.advanceTimersByTimeAsync(options.timeoutMs)
    await rejected
    expect(windowForOperation().webContents.listenerCount('ipc-message')).toBe(0)
    expect(windowForOperation().destroy).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['load', 'send', 'reply'])('cleans up after a %s failure', async (stage) => {
    const error = new Error('native failure')
    if (stage === 'load') {
      mocks.load = async () => {
        throw error
      }
    }
    const pending = runBrowserExtensionNativePage(options)
    const window = windowForOperation()
    if (stage === 'send') {
      window.webContents.send.mockImplementation(() => {
        throw error
      })
    }
    await Promise.resolve()
    if (stage === 'reply') {
      window.webContents.emit(
        'ipc-message',
        { senderFrame: window.webContents.mainFrame },
        replyChannel,
        error
      )
    }
    await expect(pending).rejects.toBe(error)
    expect(window.webContents.listenerCount('ipc-message')).toBe(0)
    expect(window.destroy).toHaveBeenCalledOnce()
  })

  it('does not create a window for an already cancelled owner or missing preload', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      runBrowserExtensionNativePage({ ...options, signal: controller.signal })
    ).rejects.toThrow()
    mocks.preloadAvailable = false
    await expect(runBrowserExtensionNativePage(options)).rejects.toThrow(
      'Native extension page preload is unavailable'
    )
    expect(mocks.windows).toHaveLength(0)
  })
})
