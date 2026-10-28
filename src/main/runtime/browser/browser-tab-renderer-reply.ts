import { randomUUID } from 'node:crypto'
import { ipcMain, type WebContents } from 'electron'
import { addFanoutListener, type FanoutEventSource } from '../../event-listener-fanout'
import {
  abortWhenRendererGone,
  type RendererLifetimeSender
} from '../../ipc/renderer-lifetime-abort'

type BrowserTabRendererWindow = FanoutEventSource & {
  isDestroyed(): boolean
  webContents: RendererLifetimeSender & Pick<WebContents, 'send' | 'isDestroyed'>
}

export function requestBrowserTabRendererReply<Reply extends { requestId: string }>(
  win: BrowserTabRendererWindow,
  channel: string,
  send: (requestId: string) => void,
  timeoutMessage: string
): Promise<Reply> {
  const sender = win.webContents
  const unavailable = (): Error => new Error('Browser tab renderer went away')
  if (win.isDestroyed() || sender.isDestroyed()) {
    return Promise.reject(unavailable())
  }
  const requestId = randomUUID()
  return new Promise<Reply>((resolve, reject) => {
    const lifetime = abortWhenRendererGone(sender)
    let settled = false
    const cleanup = (): void => {
      clearTimeout(timer)
      releaseReply()
      releaseClosed()
      lifetime.signal.removeEventListener('abort', onGone)
      lifetime.dispose()
    }
    const fail = (error: unknown): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      reject(error)
    }
    const onGone = (): void => fail(unavailable())
    const timer = setTimeout(() => fail(new Error(timeoutMessage)), 10_000)
    const releaseReply = addFanoutListener(
      ipcMain,
      channel,
      (event: Electron.IpcMainEvent, reply: Reply) => {
        if (settled || event.sender !== sender || reply?.requestId !== requestId) {
          return
        }
        settled = true
        cleanup()
        resolve(reply)
      }
    )
    const releaseClosed = addFanoutListener(win, 'closed', onGone)
    lifetime.signal.addEventListener('abort', onGone, { once: true })
    try {
      send(requestId)
    } catch (error) {
      fail(error)
    }
  })
}
