import { randomUUID } from 'node:crypto'
import { ipcMain, type BrowserWindow } from 'electron'
import { addFanoutListener } from '../../event-listener-fanout'
import { abortWhenRendererGone } from '../../ipc/renderer-lifetime-abort'

const SCOPE_REPLY_TIMEOUT_MS = 5_000

// The renderer owns host/workspace mappings and unmounted page records; null denies access.
export function rendererResolveRemoteCliWorkspace(
  getWindow: () => BrowserWindow | null,
  query: { environmentId: string; workspaceId?: string; pageId?: string },
  signal?: AbortSignal
): Promise<string | null> {
  if (signal?.aborted) {
    return Promise.resolve(null)
  }
  const win = getWindow()
  if (!win || win.isDestroyed()) {
    return Promise.resolve(null)
  }
  const rendererWebContents = win.webContents
  const requestId = randomUUID()
  return new Promise<string | null>((resolve, reject) => {
    let settled = false
    const releases: (() => void)[] = []
    const finish = (settle: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      for (const release of releases) {
        release()
      }
      settle()
    }
    const onUnavailable = (): void => finish(() => resolve(null))
    const handler = (event: Electron.IpcMainEvent, reply: unknown): void => {
      if (
        event.sender !== rendererWebContents ||
        !reply ||
        typeof reply !== 'object' ||
        !('requestId' in reply) ||
        reply.requestId !== requestId
      ) {
        return
      }
      const workspaceId =
        'workspaceId' in reply && typeof reply.workspaceId === 'string' && reply.workspaceId
          ? reply.workspaceId
          : null
      finish(() => resolve(workspaceId))
    }
    const timer = setTimeout(onUnavailable, SCOPE_REPLY_TIMEOUT_MS)
    const lifetime = abortWhenRendererGone(rendererWebContents)
    lifetime.signal.addEventListener('abort', onUnavailable, { once: true })
    signal?.addEventListener('abort', onUnavailable, { once: true })
    releases.push(
      lifetime.dispose,
      () => lifetime.signal.removeEventListener('abort', onUnavailable),
      () => signal?.removeEventListener('abort', onUnavailable),
      addFanoutListener(win, 'closed', onUnavailable),
      addFanoutListener(ipcMain, 'browser:remoteCliScopeReply', handler)
    )
    if (signal?.aborted || lifetime.signal.aborted) {
      onUnavailable()
      return
    }
    try {
      rendererWebContents.send('browser:requestRemoteCliScope', { requestId, ...query })
    } catch (error) {
      finish(() => reject(error))
    }
  })
}
