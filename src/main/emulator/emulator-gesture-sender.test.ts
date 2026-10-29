import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { WebSocketServer } from 'ws'
import { describe, expect, it, vi } from 'vitest'
import { sendEmulatorGestureSequence } from './emulator-gesture-sender'

describe('sendEmulatorGestureSequence', () => {
  it.each([1, 2, 3])('settles when the helper closes after point %i', async (closeAfter) => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await once(wss, 'listening')
    const address = wss.address()
    if (!address || typeof address === 'string') {
      throw new Error('Expected a TCP listener')
    }
    let received = 0
    wss.on('connection', (ws) => {
      ws.on('message', () => {
        received += 1
        if (received === closeAfter) {
          ws.close(1001, 'helper stopping')
        }
      })
    })
    const outcome: { state: 'pending' | 'resolved' | 'rejected'; error?: unknown } = {
      state: 'pending'
    }
    void sendEmulatorGestureSequence(`ws://127.0.0.1:${address.port}`, [
      { type: 'begin', x: 0.5, y: 0.8 },
      { type: 'move', x: 0.5, y: 0.5 },
      { type: 'end', x: 0.5, y: 0.2 }
    ]).then(
      () => {
        outcome.state = 'resolved'
      },
      (error: unknown) => {
        outcome.state = 'rejected'
        outcome.error = error
      }
    )
    try {
      await vi.waitFor(() => {
        expect(outcome.state).toBe(closeAfter === 3 ? 'resolved' : 'rejected')
      })
      expect(received).toBe(closeAfter)
      if (closeAfter < 3) {
        expect(outcome.error).toEqual(
          new Error('Emulator gesture stream closed before all points were sent')
        )
      }
    } finally {
      for (const ws of wss.clients) {
        ws.terminate()
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    }
  })

  it('sends serve-sim touch JSON frames with move events', async () => {
    const messages: unknown[] = []
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await once(wss, 'listening')
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const buffer = Array.isArray(raw)
          ? Buffer.concat(raw)
          : Buffer.isBuffer(raw)
            ? raw
            : Buffer.from(raw)
        expect(buffer[0]).toBe(0x03)
        messages.push(JSON.parse(buffer.subarray(1).toString('utf8')))
      })
    })

    try {
      const { port } = wss.address() as AddressInfo
      await sendEmulatorGestureSequence(`ws://127.0.0.1:${port}`, [
        { type: 'begin', x: 0.5, y: 0.8 },
        { type: 'move', x: 0.5, y: 0.5 },
        { type: 'end', x: 0.5, y: 0.2 }
      ])

      expect(messages).toEqual([
        { type: 'begin', x: 0.5, y: 0.8 },
        { type: 'move', x: 0.5, y: 0.5 },
        { type: 'end', x: 0.5, y: 0.2 }
      ])
    } finally {
      wss.close()
    }
  })
})
