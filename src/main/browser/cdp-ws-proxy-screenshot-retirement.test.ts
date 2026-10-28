import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type WebSocket from 'ws'
import { CdpWsProxy } from './cdp-ws-proxy'
import {
  connect,
  createMockWebContents,
  mockAsWebContents,
  sendAndReceive
} from './cdp-ws-proxy-test-harness'

vi.mock('electron', () => ({ webContents: { fromId: vi.fn() } }))

describe('CDP screenshot client retirement', () => {
  let proxy: CdpWsProxy | null = null
  let clients: WebSocket[] = []
  let pending: ReturnType<typeof Promise.withResolvers<Record<string, unknown>>>[] = []
  let successors: ReturnType<typeof Promise.withResolvers<Record<string, unknown>>>[] = []

  afterEach(async () => {
    pending.forEach((capture) => capture.resolve({ data: 'retired' }))
    successors.forEach((capture) => capture.resolve({ data: 'current' }))
    clients.forEach((client) => client.close())
    await proxy?.stop()
    clients = []
    pending = []
    successors = []
    proxy = null
  })

  it.each(['disconnect', 'replacement', 'stop'])(
    'cleans pending screenshots on %s',
    async (retirement) => {
      const mock = createMockWebContents()
      const capturePage = vi.fn()
      Object.assign(mock.webContents, { invalidate: vi.fn(), capturePage })
      const successor = Promise.withResolvers<Record<string, unknown>>()
      successors.push(successor)
      mock.webContents.debugger.sendCommand.mockImplementation(async (method, params) => {
        if (method !== 'Page.captureScreenshot') {
          return {}
        }
        if (params?.quality === 90) {
          return successor.promise
        }
        const capture = Promise.withResolvers<Record<string, unknown>>()
        pending.push(capture)
        return capture.promise
      })
      const release = vi.fn()
      const holdPaint = vi.fn(() => release)
      proxy = new CdpWsProxy(mockAsWebContents(mock, 7), holdPaint)
      const endpoint = await proxy.start()
      const oldClient = await connect(endpoint)
      clients.push(oldClient)
      const oldReply = vi.fn()
      oldClient.on('message', oldReply)
      for (const id of [1, 2]) {
        oldClient.send(
          JSON.stringify({ id, method: 'Page.captureScreenshot', params: { quality: 11 } })
        )
      }
      await vi.waitFor(() => expect(pending).toHaveLength(2))
      const oldClosed = once(oldClient, 'close')

      if (retirement === 'stop') {
        await proxy.stop()
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect(release).toHaveBeenCalledTimes(2)
      } else if (retirement === 'disconnect') {
        oldClient.close()
        await oldClosed
      }
      const currentClient = retirement === 'stop' ? null : await connect(endpoint)
      if (currentClient) {
        clients.push(currentClient)
        const reply = sendAndReceive(currentClient, {
          id: 900,
          method: 'Page.captureScreenshot',
          params: { quality: 90 }
        })
        await vi.waitFor(() => expect(holdPaint).toHaveBeenCalledTimes(3))
        await oldClosed
        await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(2))
        successor.resolve({ data: 'successor-frame' })
        await expect(reply).resolves.toMatchObject({ id: 900, result: { data: 'successor-frame' } })
      }
      await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(retirement === 'stop' ? 2 : 3))
      expect(capturePage).not.toHaveBeenCalled()
      expect(oldReply).not.toHaveBeenCalled()
    }
  )
})
