import { BrowserError } from '../../browser/browser-error'
import { requestBrowserTabRendererReply } from './browser-tab-renderer-reply'

/** Asks the renderer, which owns Orca's tab model, to close one browser page. */
export async function closeBrowserTabInRenderer(
  win: Electron.BrowserWindow,
  tabId: string | null,
  worktreeId: string | undefined
): Promise<void> {
  const reply = await requestBrowserTabRendererReply<{
    requestId: string
    error?: string
    code?: 'browser_tab_not_found'
  }>(
    win,
    'browser:tabCloseReply',
    (requestId) => {
      win.webContents.send('browser:requestTabClose', { requestId, tabId, worktreeId })
    },
    'Tab close timed out'
  )
  if (reply.error) {
    throw reply.code === 'browser_tab_not_found'
      ? new BrowserError('browser_tab_not_found', reply.error)
      : new Error(reply.error)
  }
}
