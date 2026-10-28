import { BrowserWindow } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { getChromeExtensionOrigin } from '../../../shared/browser-extension-url'

const nativePages = new WeakSet<Electron.WebContents>()
// Why: web-contents-created fires inside the BrowserWindow constructor, before nativePages.add.
let creatingNativePage = false

export function isBrowserExtensionNativePage(contents: Electron.WebContents): boolean {
  return creatingNativePage || nativePages.has(contents)
}

/** Native extension bindings without Orca's API wrappers, always on a hidden document. */
export async function runBrowserExtensionNativePage(options: {
  session: Electron.Session
  extensionId: string
  code: string
  timeoutMs: number
  signal?: AbortSignal
}): Promise<unknown> {
  const { session, extensionId, code, timeoutMs, signal } = options
  signal?.throwIfAborted()
  const preload = [
    join(__dirname, 'browser-extension-native-page-preload.js'),
    join(__dirname, '..', 'browser-extension-native-page-preload.js')
  ].find(existsSync)
  if (!preload) {
    throw new Error('Native extension page preload is unavailable')
  }
  creatingNativePage = true
  let window: BrowserWindow
  try {
    window = new BrowserWindow({
      show: false,
      webPreferences: {
        session,
        preload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false
      }
    })
  } finally {
    creatingNativePage = false
  }
  nativePages.add(window.webContents)
  let timer: NodeJS.Timeout | undefined
  let onAbort: (() => void) | undefined
  let onReply:
    | ((event: Electron.IpcMainEvent, channel: string, error: unknown, value: unknown) => void)
    | undefined
  try {
    return await Promise.race([
      (async () => {
        await window.loadURL(
          `${getChromeExtensionOrigin(extensionId)}/manifest.json?orca-native-page=1`
        )
        signal?.throwIfAborted()
        return new Promise<unknown>((resolve, reject) => {
          onReply = (event, channel, error, value) => {
            if (
              channel !== 'browser-extension-native-page:reply' ||
              event.senderFrame !== window.webContents.mainFrame
            ) {
              return
            }
            if (error) {
              reject(error)
            } else {
              resolve(value)
            }
          }
          // WebContents.executeJavaScript keeps its global reply listener after cancellation.
          window.webContents.on('ipc-message', onReply)
          window.webContents.send('browser-extension-native-page:execute', code)
        })
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Native extension operation timed out')),
          timeoutMs
        )
        onAbort = () => reject(new Error('Extension context was unloaded'))
        signal?.addEventListener('abort', onAbort, { once: true })
        if (signal?.aborted) {
          onAbort()
        }
      })
    ])
  } finally {
    if (onReply) {
      window.webContents.removeListener('ipc-message', onReply)
    }
    clearTimeout(timer)
    if (onAbort) {
      signal?.removeEventListener('abort', onAbort)
    }
    window.destroy()
  }
}
