import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentLaunchTabPublishReply,
  AgentLaunchTabPublishRequest
} from '../../shared/agent-launch-tab-publication'

const ipcMain = new EventEmitter()
vi.mock('electron', () => ({ ipcMain }))

const { requestAgentLaunchTabPublishFromRenderer: publish } =
  await import('./agent-launch-tab-publish-relay')

const request: Omit<AgentLaunchTabPublishRequest, 'requestId'> = {
  worktreeId: 'repo::/srv/app',
  tabId: 'tab-1',
  leafId: 'leaf-1',
  launchAgent: 'codex',
  viewMode: 'terminal',
  viewer: 'none'
}

function fixture() {
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    send: vi.fn<(channel: string, value: AgentLaunchTabPublishRequest) => void>()
  })
  const events = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    webContents: contents
  })
  // SAFETY: the fixture supplies the window/contents events, destruction checks and send used by the relay.
  const window = events as unknown as BrowserWindow
  const sent = (index = 0): AgentLaunchTabPublishRequest => {
    const [channel, value] = contents.send.mock.calls[index] ?? []
    expect(channel).toBe('ui:publishAgentLaunchTab')
    return value ?? { ...request, requestId: '' }
  }
  const reply = (index = 0, error?: string): void => {
    const response: AgentLaunchTabPublishReply = error
      ? { requestId: sent(index).requestId, error }
      : {
          requestId: sent(index).requestId,
          tabId: request.tabId,
          created: true,
          placement: { groupId: 'group-1' }
        }
    ipcMain.emit('agentLaunch:tabPublishReply', { sender: contents }, response)
  }
  const expectReleased = (): void => {
    expect(contents.eventNames()).toEqual([])
    expect(events.eventNames()).toEqual([])
  }
  return { window, contents, events, sent, reply, expectReleased }
}

describe('agent launch tab publication lifetime', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    expect(ipcMain.eventNames()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })

  it.each(['did-navigate', 'render-process-gone', 'destroyed', 'closed'])(
    'retires pending publication on %s and releases every request resource',
    async (event) => {
      const f = fixture()
      const pending = publish(f.window, request).catch((error: Error) => error.message)
      ;(event === 'closed' ? f.events : f.contents).emit(event)
      await expect(pending).resolves.toBe('renderer_unavailable')
      f.reply()
      f.expectReleased()
    }
  )

  it('shares native listeners across a burst and preserves a different window', async () => {
    const retired = fixture()
    const survivor = fixture()
    const pending = Array.from({ length: 100 }, () =>
      publish(retired.window, request).catch((error: Error) => error.message)
    )
    const live = publish(survivor.window, request)
    expect(ipcMain.listenerCount('agentLaunch:tabPublishReply')).toBe(1)
    expect(retired.events.listenerCount('closed')).toBe(1)
    for (const event of ['did-navigate', 'render-process-gone', 'destroyed']) {
      expect(retired.contents.listenerCount(event)).toBe(1)
    }
    retired.contents.emit('did-navigate')
    await expect(Promise.all(pending)).resolves.toEqual(Array(100).fill('renderer_unavailable'))
    retired.expectReleased()
    expect(vi.getTimerCount()).toBe(1)
    retired.reply()
    survivor.reply()
    await expect(live).resolves.toEqual({
      tabId: request.tabId,
      created: true,
      placement: { groupId: 'group-1' }
    })
    survivor.expectReleased()
  })

  it('ignores a late predecessor reply while its successor awaits its own reply', async () => {
    const f = fixture()
    const old = publish(f.window, request).catch((error: Error) => error.message)
    f.contents.emit('did-navigate')
    await expect(old).resolves.toBe('renderer_unavailable')
    const current = publish(f.window, request)
    f.reply(0)
    expect(vi.getTimerCount()).toBe(1)
    f.reply(1)
    await expect(current).resolves.toMatchObject({ created: true })
    f.expectReleased()
  })

  it('keeps same-document and blocked navigation live, accepting only its targeted reply', async () => {
    const f = fixture()
    const pending = publish(f.window, request)
    f.contents.emit('did-navigate-in-page', {}, '#section', true)
    f.contents.emit('will-navigate', {}, 'https://blocked.test')
    f.contents.emit('did-start-navigation', {}, 'https://blocked.test', false, true)
    ipcMain.emit('agentLaunch:tabPublishReply', { sender: {} }, { requestId: f.sent().requestId })
    ipcMain.emit('agentLaunch:tabPublishReply', { sender: f.contents }, { requestId: 'other' })
    expect(vi.getTimerCount()).toBe(1)
    f.reply()
    await expect(pending).resolves.toMatchObject({ tabId: request.tabId, created: true })
    f.expectReleased()
  })

  it('releases a renderer rejection and preserves its error', async () => {
    const f = fixture()
    const pending = publish(f.window, request).catch((error: Error) => error.message)
    f.reply(0, 'agent_launch_tab_id_taken')
    await expect(pending).resolves.toBe('agent_launch_tab_id_taken')
    f.expectReleased()
  })

  it('releases listeners and the deadline when sending throws', async () => {
    const f = fixture()
    f.contents.send.mockImplementation(() => {
      throw new Error('Render frame disposed')
    })
    await expect(publish(f.window, request)).rejects.toThrow('renderer_unavailable')
    f.expectReleased()
  })

  it('retains the existing deadline for a live document that never replies', async () => {
    const f = fixture()
    const pending = publish(f.window, request).catch((error: Error) => error.message)
    await vi.advanceTimersByTimeAsync(9_999)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    await expect(pending).resolves.toBe('agent_launch_tab_publish_timeout')
    f.expectReleased()
  })
})
