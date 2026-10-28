import type { RuntimeBrowserCommandHost } from './browser-command-contracts'
import { requestBrowserTabRendererReply } from './browser-tab-renderer-reply'

export async function createBrowserTabInRenderer(
  host: Pick<RuntimeBrowserCommandHost, 'getAuthoritativeWindow'>,
  url: string,
  worktreeId: string | undefined,
  profileId: string | undefined,
  sessionPartition: string | undefined,
  activate?: boolean,
  requestedPageId?: string,
  /** Used only when `worktreeId` is unset and no workspace is active in the renderer. */
  fallbackWorktreeId?: string
): Promise<{ browserPageId: string }> {
  const win = host.getAuthoritativeWindow()
  const reply = await requestBrowserTabRendererReply<{
    requestId: string
    browserPageId?: string
    error?: string
  }>(
    win,
    'browser:tabCreateReply',
    (requestId) => {
      win.webContents.send('browser:requestTabCreate', {
        requestId,
        url,
        worktreeId,
        ...(requestedPageId ? { browserPageId: requestedPageId } : {}),
        // undefined preserves renderer default-profile inheritance; null would override it.
        sessionProfileId: profileId,
        sessionPartition,
        activate,
        ...(fallbackWorktreeId ? { fallbackWorktreeId } : {})
      })
    },
    'Tab creation timed out'
  )
  if (reply.error) {
    throw new Error(reply.error)
  }
  return { browserPageId: reply.browserPageId! }
}
