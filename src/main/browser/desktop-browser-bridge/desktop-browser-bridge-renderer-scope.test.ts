import { EventEmitter } from 'node:events'
import { ipcMain, type BrowserWindow } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RemoteCliBrowserScopeQuery } from '../../../shared/desktop-browser-bridge-protocol'
import { rendererResolveRemoteCliWorkspace } from './desktop-browser-bridge-renderer-scope'

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return { ipcMain: new EventEmitter() }
})

const query = { environmentId: 'host', workspaceId: 'workspace' }
const fixtures: ReturnType<typeof createFixture>[] = []
let nextContentsId = 0

function createFixture() {
  let destroyed = false
  const contents = Object.assign(new EventEmitter(), {
    id: ++nextContentsId,
    isDestroyed: () => destroyed,
    send: vi.fn<(channel: string, query: RemoteCliBrowserScopeQuery) => void>()
  })
  const window = Object.assign(new EventEmitter(), {
    webContents: contents,
    isDestroyed: () => destroyed
  })
  // SAFETY: the relay reads only webContents, destroyed state and the supplied EventEmitter methods.
  const getWindow = (): BrowserWindow => window as unknown as BrowserWindow
  return {
    contents,
    window,
    getWindow,
    retire(event: string) {
      if (event === 'destroyed' || event === 'closed') {
        destroyed = true
      }
      if (event === 'closed') {
        window.emit(event)
      } else {
        contents.emit(event)
      }
    }
  }
}

function fixture() {
  const owner = createFixture()
  fixtures.push(owner)
  return owner
}

function reply(owner: ReturnType<typeof fixture>, index: number, workspaceId: string | null): void {
  const request = owner.contents.send.mock.calls[index]?.[1]
  if (!request) {
    throw new Error('Expected a scope request')
  }
  ipcMain.emit(
    'browser:remoteCliScopeReply',
    { sender: owner.contents },
    { requestId: request.requestId, workspaceId }
  )
}

function expectReleased(owner: ReturnType<typeof fixture>): void {
  for (const event of ['destroyed', 'render-process-gone', 'did-navigate']) {
    expect(owner.contents.listenerCount(event)).toBe(0)
  }
  expect(owner.window.listenerCount('closed')).toBe(0)
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  for (const owner of fixtures.splice(0)) {
    owner.retire('closed')
  }
  vi.runAllTimers()
  expect(ipcMain.listenerCount('browser:remoteCliScopeReply')).toBe(0)
  vi.useRealTimers()
})

describe('remote CLI renderer workspace scope', () => {
  it.each(['did-navigate', 'render-process-gone', 'destroyed', 'closed'])(
    'retires concurrent requests when their owner emits %s',
    async (event) => {
      const owner = fixture()
      const requests = Array.from({ length: 20 }, () =>
        rendererResolveRemoteCliWorkspace(owner.getWindow, query)
      )

      expect(ipcMain.listenerCount('browser:remoteCliScopeReply')).toBe(1)
      expect(owner.contents.listenerCount('destroyed')).toBe(1)
      expect(owner.window.listenerCount('closed')).toBe(1)
      owner.retire(event)

      await expect(Promise.all(requests)).resolves.toEqual(Array(20).fill(null))
      expect(vi.getTimerCount()).toBe(0)
      expectReleased(owner)
    }
  )

  it('cancels one command while another request on the same renderer completes', async () => {
    const owner = fixture()
    const cancelled = new AbortController()
    const first = rendererResolveRemoteCliWorkspace(owner.getWindow, query, cancelled.signal)
    const second = rendererResolveRemoteCliWorkspace(owner.getWindow, query)

    cancelled.abort()
    await expect(first).resolves.toBeNull()
    expect(vi.getTimerCount()).toBe(1)
    expect(ipcMain.listenerCount('browser:remoteCliScopeReply')).toBe(1)
    reply(owner, 0, 'obsolete')
    expect(vi.getTimerCount()).toBe(1)
    reply(owner, 1, 'workspace')

    await expect(second).resolves.toBe('workspace')
    expect(vi.getTimerCount()).toBe(0)
    expectReleased(owner)
  })

  it('keeps a surviving renderer request when another window closes', async () => {
    const firstOwner = fixture()
    const secondOwner = fixture()
    const first = rendererResolveRemoteCliWorkspace(firstOwner.getWindow, query)
    const second = rendererResolveRemoteCliWorkspace(secondOwner.getWindow, query)

    firstOwner.retire('closed')
    await expect(first).resolves.toBeNull()
    expectReleased(firstOwner)
    expect(vi.getTimerCount()).toBe(1)
    reply(secondOwner, 0, 'survivor')

    await expect(second).resolves.toBe('survivor')
    expectReleased(secondOwner)
  })

  it('accepts only the exact sender and request, preserving the request payload', async () => {
    const owner = fixture()
    const requested = { ...query, pageId: 'page' }
    const pending = rendererResolveRemoteCliWorkspace(owner.getWindow, requested)
    const sent = owner.contents.send.mock.calls[0]?.[1]
    expect(sent).toEqual({ ...requested, requestId: expect.any(String) })
    ipcMain.emit(
      'browser:remoteCliScopeReply',
      { sender: { id: owner.contents.id } },
      { requestId: sent?.requestId, workspaceId: 'foreign' }
    )
    ipcMain.emit(
      'browser:remoteCliScopeReply',
      { sender: owner.contents },
      { requestId: 'wrong', workspaceId: 'foreign' }
    )
    expect(vi.getTimerCount()).toBe(1)
    reply(owner, 0, 'workspace')

    await expect(pending).resolves.toBe('workspace')
    expectReleased(owner)
  })

  it('preserves a request across same-document and uncommitted navigation', async () => {
    const owner = fixture()
    const pending = rendererResolveRemoteCliWorkspace(owner.getWindow, query)
    owner.contents.emit('did-navigate-in-page', {}, 'https://orca.test/#next', true)
    owner.contents.emit('did-start-navigation', {}, 'https://external.test/', false, true)
    owner.contents.emit('did-start-loading')

    expect(vi.getTimerCount()).toBe(1)
    reply(owner, 0, 'workspace')
    await expect(pending).resolves.toBe('workspace')
    expectReleased(owner)
  })

  it.each([null, ''])('preserves a renderer refusal of %s', async (workspaceId) => {
    const owner = fixture()
    const pending = rendererResolveRemoteCliWorkspace(owner.getWindow, query)
    reply(owner, 0, workspaceId)

    await expect(pending).resolves.toBeNull()
    expect(vi.getTimerCount()).toBe(0)
    expectReleased(owner)
  })

  it('keeps the five-second deadline and releases its owners after it expires', async () => {
    const owner = fixture()
    const pending = rendererResolveRemoteCliWorkspace(owner.getWindow, query)
    vi.advanceTimersByTime(4_999)
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(1)

    await expect(pending).resolves.toBeNull()
    expectReleased(owner)
  })

  it.each([new Error('frame disposed'), undefined])(
    'rejects with the original send failure %s and immediately releases its owners',
    async (failure) => {
      const owner = fixture()
      owner.contents.send.mockImplementationOnce(() => {
        throw failure
      })

      await expect(rendererResolveRemoteCliWorkspace(owner.getWindow, query)).rejects.toBe(failure)
      expect(vi.getTimerCount()).toBe(0)
      expectReleased(owner)
    }
  )

  it('does not allocate a request for an already cancelled command or missing window', async () => {
    const cancelled = new AbortController()
    cancelled.abort()
    const getWindow = vi.fn(() => null)

    await expect(
      rendererResolveRemoteCliWorkspace(getWindow, query, cancelled.signal)
    ).resolves.toBeNull()
    expect(getWindow).not.toHaveBeenCalled()
    await expect(rendererResolveRemoteCliWorkspace(getWindow, query)).resolves.toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })
})
