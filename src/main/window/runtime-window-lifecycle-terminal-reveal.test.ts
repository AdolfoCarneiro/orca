import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { RuntimeNotifier } from '../runtime/runtime-notifier-contract'

const { ipcMain } = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  return { ipcMain: new EventEmitter() }
})
vi.mock('electron', () => ({ ipcMain }))
vi.mock('../ipc/worktree-change-invalidators', () => ({ runWorktreeChangeInvalidators: vi.fn() }))
vi.mock('./renderer-document-navigation', () => ({ registerRendererDocumentNavigation: vi.fn() }))

import { registerRuntimeWindowLifecycle } from './runtime-window-lifecycle'

function attachWindow(id: number): {
  destroy: () => void
  notifier: RuntimeNotifier
  send: ReturnType<typeof vi.fn>
  webContents: EventEmitter
  close: () => void
  reveal: NonNullable<RuntimeNotifier['revealTerminalSession']>
} {
  let destroyed = false
  const send = vi.fn()
  const webContents = Object.assign(new EventEmitter(), { isDestroyed: () => false, send })
  const attached: { notifier: RuntimeNotifier | null } = { notifier: null }
  const mainWindow = Object.assign(new EventEmitter(), {
    id,
    isDestroyed: () => destroyed,
    // Electron's BrowserWindow getter throws once the native window is gone.
    get webContents() {
      if (destroyed) {
        throw new TypeError('Object has been destroyed')
      }
      return webContents
    }
  })
  const runtime = {
    attachWindow: vi.fn(),
    markGraphReloadFailed: vi.fn(),
    markGraphUnavailable: vi.fn(),
    setNotifier: (next: RuntimeNotifier | null) => {
      attached.notifier = next
    }
  }
  registerRuntimeWindowLifecycle(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture provides window identity, destruction checks, WebContents and real EventEmitter methods.
    mainWindow as unknown as BrowserWindow,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: registration only calls the stubbed runtime members.
    runtime as unknown as OrcaRuntimeService
  )
  if (!attached.notifier?.revealTerminalSession) {
    throw new Error('runtime notifier was not attached')
  }
  return {
    destroy: () => {
      destroyed = true
    },
    notifier: attached.notifier,
    send,
    webContents,
    close: () => mainWindow.emit('closed'),
    reveal: attached.notifier.revealTerminalSession
  }
}

describe('runtime window terminal reveal', () => {
  afterEach(() => {
    if (vi.isFakeTimers()) {
      vi.runOnlyPendingTimers()
      vi.useRealTimers()
    }
  })

  it.each(['did-navigate', 'render-process-gone', 'destroyed', 'closed'])(
    'retires pending acknowledgements on %s without waiting for their deadline',
    async (event) => {
      vi.useFakeTimers()
      for (const count of [1, 10, 100]) {
        const window = attachWindow(count)
        const replies = Array.from({ length: count }, (_, index) =>
          window.reveal(`wt-${index}`, { ptyId: `pty-${index}` }).then(
            () => 'unexpected-success',
            (error: Error) => error.message
          )
        )
        expect(vi.getTimerCount()).toBe(count)
        expect(ipcMain.listenerCount('terminal:tabCreateReply')).toBe(1)
        if (event === 'closed') {
          window.close()
        } else {
          window.webContents.emit(event, {}, 'https://orca.test/reloaded', 200, 'OK')
        }
        expect(vi.getTimerCount()).toBe(0)
        expect(ipcMain.listenerCount('terminal:tabCreateReply')).toBe(0)
        await expect(Promise.all(replies)).resolves.toEqual(
          Array(count).fill('runtime_unavailable')
        )
      }
    }
  )

  it('preserves live and sibling requests through same-document and provisional events', async () => {
    vi.useFakeTimers()
    const window = attachWindow(10)
    const sibling = attachWindow(11)
    const retired = window.reveal('wt', { ptyId: 'pty' })
    const retiredReply = retired.catch((error: Error) => error.message)
    const live = sibling.reveal('sibling', { ptyId: 'pty-sibling' }).catch((error: Error) => error)
    for (const event of ['did-navigate-in-page', 'did-start-navigation', 'did-frame-navigate']) {
      sibling.webContents.emit(event, {}, 'https://orca.test/#hash', false, false)
    }
    expect(vi.getTimerCount()).toBe(2)
    window.webContents.emit('did-navigate')
    expect(vi.getTimerCount()).toBe(1)
    await expect(retiredReply).resolves.toBe('runtime_unavailable')
    const [, request] = sibling.send.mock.calls[0]
    ipcMain.emit(
      'terminal:tabCreateReply',
      { sender: window.webContents },
      {
        requestId: request.requestId,
        tabId: 'foreign'
      }
    )
    expect(vi.getTimerCount()).toBe(1)
    ipcMain.emit(
      'terminal:tabCreateReply',
      { sender: sibling.webContents },
      {
        requestId: request.requestId,
        tabId: 'live-tab'
      }
    )
    await expect(live).resolves.toEqual({ tabId: 'live-tab', title: undefined })
    expect(vi.getTimerCount()).toBe(0)
    expect(ipcMain.listenerCount('terminal:tabCreateReply')).toBe(0)
  })

  it('releases ownership after a renderer send failure', async () => {
    vi.useFakeTimers()
    const window = attachWindow(20)
    window.send.mockImplementation(() => {
      throw new Error('frame unavailable')
    })
    await expect(window.reveal('wt', { ptyId: 'pty' })).rejects.toThrow('runtime_unavailable')
    expect(vi.getTimerCount()).toBe(0)
    expect(ipcMain.listenerCount('terminal:tabCreateReply')).toBe(0)
    expect(window.webContents.listenerCount('did-navigate')).toBe(0)
  })

  it('lets a replacement window answer while a closed window still has a pending reveal', async () => {
    vi.useFakeTimers()
    try {
      const closedWindow = attachWindow(1)
      const stale = Promise.resolve(
        closedWindow.notifier.revealTerminalSession?.('wt-1', { ptyId: 'pty-1' })
      )
      const staleSettled = expect(stale).rejects.toThrow('Terminal reveal timed out')
      closedWindow.destroy()

      const nextWindow = attachWindow(2)
      const reveal = nextWindow.notifier.revealTerminalSession?.('wt-1', { ptyId: 'pty-2' })
      const [, payload] = nextWindow.send.mock.calls[0]

      expect(() =>
        ipcMain.emit(
          'terminal:tabCreateReply',
          { sender: nextWindow.webContents },
          { requestId: payload.requestId, tabId: 'tab-2' }
        )
      ).not.toThrow()
      await expect(reveal).resolves.toEqual({ tabId: 'tab-2', title: undefined })

      await vi.advanceTimersByTimeAsync(10_000)
      await staleSettled
      expect(ipcMain.listenerCount('terminal:tabCreateReply')).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
