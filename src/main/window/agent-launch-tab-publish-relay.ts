import { randomUUID } from 'node:crypto'

import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import type {
  AgentLaunchTabPublished,
  AgentLaunchTabPublishReply,
  AgentLaunchTabPublishRequest
} from '../../shared/agent-launch-tab-publication'
import { addFanoutListener } from '../event-listener-fanout'
import { abortWhenRendererGone } from '../ipc/renderer-lifetime-abort'

const AGENT_LAUNCH_TAB_PUBLISH_TIMEOUT_MS = 10_000

/** Asks the window to show a launch's tab under the host's ids; resolves with where it landed. */
export function requestAgentLaunchTabPublishFromRenderer(
  mainWindow: BrowserWindow,
  request: Omit<AgentLaunchTabPublishRequest, 'requestId'>
): Promise<AgentLaunchTabPublished> {
  if (mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
    return Promise.reject(new Error('renderer_unavailable'))
  }
  const webContents = mainWindow.webContents
  const requestId = randomUUID()
  return new Promise<AgentLaunchTabPublished>((resolve, reject) => {
    let settled = false
    const releaseListeners: (() => void)[] = []
    const finish = (error: Error | null, published?: AgentLaunchTabPublished): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      for (const release of releaseListeners) {
        release()
      }
      if (error) {
        reject(error)
      } else if (published) {
        resolve(published)
      }
    }
    const timeout = setTimeout(
      () => finish(new Error('agent_launch_tab_publish_timeout')),
      AGENT_LAUNCH_TAB_PUBLISH_TIMEOUT_MS
    )
    const onRendererUnavailable = (): void => finish(new Error('renderer_unavailable'))
    const onReply = (event: Electron.IpcMainEvent, reply: AgentLaunchTabPublishReply): void => {
      // Renderer-visible request IDs grant no authority; accept only the targeted window's reply.
      if (event.sender !== webContents || reply.requestId !== requestId) {
        return
      }
      if ('error' in reply) {
        finish(new Error(reply.error))
        return
      }
      finish(null, { tabId: reply.tabId, created: reply.created, placement: reply.placement })
    }
    const lifetime = abortWhenRendererGone(webContents)
    lifetime.signal.addEventListener('abort', onRendererUnavailable, { once: true })
    releaseListeners.push(
      lifetime.dispose,
      () => lifetime.signal.removeEventListener('abort', onRendererUnavailable),
      addFanoutListener(mainWindow, 'closed', onRendererUnavailable),
      addFanoutListener(ipcMain, 'agentLaunch:tabPublishReply', onReply)
    )
    try {
      webContents.send('ui:publishAgentLaunchTab', { ...request, requestId })
    } catch {
      finish(new Error('renderer_unavailable'))
    }
  })
}
