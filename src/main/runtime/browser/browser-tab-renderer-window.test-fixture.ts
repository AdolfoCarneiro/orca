import { EventEmitter } from 'node:events'
import { vi } from 'vitest'

export function createBrowserTabRendererContents() {
  return Object.assign(new EventEmitter(), { send: vi.fn(), isDestroyed: () => false })
}

export function createBrowserTabRendererWindow(
  webContents: ReturnType<typeof createBrowserTabRendererContents>
) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: command tests use only the real EventEmitter lifecycle methods, webContents and isDestroyed supplied by this window fixture.
  return Object.assign(new EventEmitter(), {
    webContents,
    isDestroyed: () => false
  }) as unknown as Electron.BrowserWindow
}
