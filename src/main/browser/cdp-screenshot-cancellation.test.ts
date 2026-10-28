import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { captureScreenshot } from './cdp-screenshot'
import { createMockWebContents, mockAsWebContents } from './cdp-ws-proxy-test-harness'

function createCapture() {
  const mock = createMockWebContents()
  mock.webContents.debugger.isAttached.mockReturnValue(true)
  const encode = vi.fn(() => Buffer.from('current-frame'))
  const image = { isEmpty: () => false, toPNG: encode }
  const capturePage = vi.fn<() => Promise<typeof image>>()
  Object.assign(mock.webContents, { invalidate: vi.fn(), capturePage })
  const release = vi.fn()
  const holdPaint = vi.fn(() => release)
  return { mock, guest: mockAsWebContents(mock, 7), image, encode, capturePage, release, holdPaint }
}

describe('screenshot cancellation', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('rejects an already retired capture before acquiring paint or sending commands', async () => {
    const capture = createCapture()
    const controller = new AbortController()
    const reason = new Error('retired')
    controller.abort(reason)

    await expect(
      captureScreenshot(capture.guest, {}, capture.holdPaint, controller.signal)
    ).rejects.toBe(reason)
    expect(capture.holdPaint).not.toHaveBeenCalled()
    expect(capture.mock.webContents.debugger.sendCommand).not.toHaveBeenCalled()
  })

  it('releases paint promptly and starts no probes or fallback after retirement', async () => {
    const capture = createCapture()
    capture.mock.webContents.debugger.sendCommand.mockImplementation(() => new Promise(() => {}))
    const controller = new AbortController()
    const reason = new Error('retired')
    const failed = vi.fn()
    const result = captureScreenshot(capture.guest, {}, capture.holdPaint, controller.signal)
    void result.catch(failed)

    controller.abort(reason)
    await vi.advanceTimersByTimeAsync(0)
    expect(capture.release).toHaveBeenCalledTimes(1)
    expect(failed).toHaveBeenCalledWith(reason)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(9000)
    expect(capture.mock.webContents.debugger.sendCommand).toHaveBeenCalledTimes(1)
    expect(capture.capturePage).not.toHaveBeenCalled()
  })

  it('ignores an original CDP reply delivered after retirement', async () => {
    const capture = createCapture()
    const pending = Promise.withResolvers<Record<string, unknown>>()
    capture.mock.webContents.debugger.sendCommand.mockReturnValue(pending.promise)
    const controller = new AbortController()
    const reason = new Error('retired')
    const result = captureScreenshot(capture.guest, {}, capture.holdPaint, controller.signal)
    const settled = expect(result).rejects.toBe(reason)

    controller.abort(reason)
    pending.resolve({ data: 'obsolete-frame' })
    await settled
    expect(capture.release).toHaveBeenCalledTimes(1)
    expect(capture.capturePage).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('releases an in-flight native fallback and never encodes its late image', async () => {
    const capture = createCapture()
    capture.mock.webContents.debugger.sendCommand.mockImplementation(() => new Promise(() => {}))
    const pending = Promise.withResolvers<typeof capture.image>()
    capture.capturePage.mockReturnValue(pending.promise)
    const controller = new AbortController()
    const reason = new Error('retired')
    const failed = vi.fn()
    const result = captureScreenshot(capture.guest, {}, capture.holdPaint, controller.signal)
    void result.catch(failed)
    await vi.advanceTimersByTimeAsync(8000)
    expect(capture.capturePage).toHaveBeenCalledTimes(1)

    controller.abort(reason)
    await vi.advanceTimersByTimeAsync(0)
    expect(capture.release).toHaveBeenCalledTimes(1)
    pending.resolve(capture.image)
    await vi.advanceTimersByTimeAsync(0)
    expect(failed).toHaveBeenCalledWith(reason)
    expect(capture.encode).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves the current capture result with a live signal', async () => {
    const capture = createCapture()
    const controller = new AbortController()

    await expect(
      captureScreenshot(capture.guest, { format: 'png' }, capture.holdPaint, controller.signal)
    ).resolves.toEqual({ data: 'png' })
    expect(capture.release).toHaveBeenCalledTimes(1)
    expect(capture.capturePage).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
