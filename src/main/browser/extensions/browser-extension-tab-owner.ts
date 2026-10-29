import { webContents } from 'electron'
import { browserManager } from '../browser-manager'
import {
  getBrowserExtensionMainWindow,
  getPopoutWindowForWebContents
} from './browser-extension-window-model'

export function liveBrowserExtensionTabContents(
  id: number | null | undefined
): Electron.WebContents | null {
  const contents = id == null ? undefined : webContents.fromId(id)
  return contents && !contents.isDestroyed() ? contents : null
}

type BrowserExtensionTabWindow = {
  contents: Electron.WebContents
  window: Electron.BrowserWindow
  windowType: 'normal' | 'popup'
}

export function resolveBrowserExtensionTabWindow(tabId: number): BrowserExtensionTabWindow | null {
  const contents = liveBrowserExtensionTabContents(tabId)
  if (!contents) {
    return null
  }
  const popout = getPopoutWindowForWebContents(contents)
  if (popout) {
    return { contents, window: popout, windowType: 'popup' }
  }
  const window = getBrowserExtensionMainWindow()
  return window ? { contents, window, windowType: 'normal' } : null
}

/** Request events need their current owner, without tab position or active-tab state. */
export function resolveBrowserExtensionTabOwner(
  tabId: number
): { contents: Electron.WebContents; windowId: number; windowType: 'normal' | 'popup' } | null {
  const owner = resolveBrowserExtensionTabWindow(tabId)
  if (!owner) {
    return null
  }
  const { contents, window, windowType } = owner
  if (windowType === 'normal') {
    const browserPageId = browserManager.getTabIdForWebContentsId(tabId)
    const registered =
      browserPageId !== null && browserManager.getGuestWebContentsId(browserPageId) === tabId
    const isMainWindowGuest =
      contents.getType() === 'webview' && contents.hostWebContents === window.webContents
    // Duplicate page aliases can outlive their reverse entry after unregistering.
    if (
      !registered &&
      !isMainWindowGuest &&
      ![...browserManager.getWebContentsIdByTabId().values()].includes(tabId)
    ) {
      return null
    }
  }
  return { contents, windowId: window.id, windowType }
}
