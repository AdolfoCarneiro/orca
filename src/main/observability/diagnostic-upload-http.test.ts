import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { httpRequestMock, httpsRequestMock } = vi.hoisted(() => ({
  httpRequestMock: vi.fn(),
  httpsRequestMock: vi.fn()
}))

vi.mock('node:http', () => ({ request: httpRequestMock }))
vi.mock('node:https', () => ({ request: httpsRequestMock }))

import { MAX_RESPONSE_BYTES, postJsonForJson } from './diagnostic-upload-http'

class FakeRequest extends EventEmitter {
  destroy = vi.fn()
  end = vi.fn()
  write = vi.fn()
}

class FakeResponse extends EventEmitter {
  statusCode = 200
  destroy = vi.fn()
}

describe('diagnostic upload HTTP', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('reports only the status for an error response with an invalid JSON body', async () => {
    const request = new FakeRequest()
    const response = new FakeResponse()
    response.statusCode = 503
    httpRequestMock.mockImplementationOnce((_options, callback) => {
      callback(response)
      return request
    })
    const result = postJsonForJson('http://diagnostics.example/upload', {}, 1000)
    response.emit('data', Buffer.from('private backend details: not JSON'))
    response.emit('end')
    await expect(result).rejects.toThrow(/^HTTP 503$/)
    request.emit('close')
    expect(response.listenerCount('data')).toBe(0)
    expect(request.listenerCount('error')).toBe(0)
  })

  it('removes request and response listeners after a successful response', async () => {
    const request = new FakeRequest()
    const response = new FakeResponse()
    httpRequestMock.mockImplementationOnce((_options, callback) => {
      callback(response)
      return request
    })

    const result = postJsonForJson('http://diagnostics.example/upload', { ok: true }, 1000)
    response.emit('data', Buffer.from('{"accepted":true}'))
    response.emit('end')

    await expect(result).resolves.toEqual({ accepted: true })
    request.emit('close')
    expect(request.listenerCount('error')).toBe(0)
    expect(request.listenerCount('timeout')).toBe(0)
    expect(response.listenerCount('data')).toBe(0)
    expect(response.listenerCount('end')).toBe(0)
    expect(response.listenerCount('error')).toBe(0)
  })

  it('removes listeners after rejecting an oversized response', async () => {
    const request = new FakeRequest()
    const response = new FakeResponse()
    httpRequestMock.mockImplementationOnce((_options, callback) => {
      callback(response)
      return request
    })

    const result = postJsonForJson('http://diagnostics.example/upload', { ok: true }, 1000)
    response.emit('data', Buffer.alloc(MAX_RESPONSE_BYTES + 1))

    await expect(result).rejects.toThrow('diagnostic response exceeded size limit')
    request.emit('close')
    expect(request.destroy).toHaveBeenCalledTimes(1)
    expect(response.destroy).toHaveBeenCalledTimes(1)
    expect(request.listenerCount('error')).toBe(0)
    expect(request.listenerCount('timeout')).toBe(0)
    expect(response.listenerCount('data')).toBe(0)
    expect(response.listenerCount('end')).toBe(0)
    expect(response.listenerCount('error')).toBe(0)
  })

  it('handles the asynchronous socket error after a request timeout until close', async () => {
    const request = new FakeRequest()
    httpRequestMock.mockReturnValueOnce(request)
    const result = postJsonForJson('http://diagnostics.example/upload', {}, 1000)
    request.emit('timeout')

    await expect(result).rejects.toThrow('diagnostic network request timed out')
    expect(request.destroy).toHaveBeenCalledOnce()
    expect(() => request.emit('error', new Error('socket hang up'))).not.toThrow()
    request.emit('close')
    expect(request.eventNames()).toEqual([])
  })

  it('expires a response that keeps receiving data before the socket idle timeout', async () => {
    const request = new FakeRequest()
    const response = new FakeResponse()
    httpRequestMock.mockImplementationOnce((_options, callback) => {
      callback(response)
      return request
    })
    const result = postJsonForJson('http://diagnostics.example/upload', {}, 1000)
    const outcome = result.catch((error: Error) => error.message)
    for (let chunk = 0; chunk < 3; chunk++) {
      await vi.advanceTimersByTimeAsync(300)
      response.emit('data', Buffer.from(' '))
    }
    await vi.advanceTimersByTimeAsync(100)

    expect(request.destroy).toHaveBeenCalledExactlyOnceWith()
    expect(await outcome).toBe('diagnostic network request timed out')
    expect(response.listenerCount('data')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(() => request.emit('error', new Error('socket hang up'))).not.toThrow()
    request.emit('close')
    expect(request.eventNames()).toEqual([])
  })

  it('clears the elapsed deadline when a streamed response completes in time', async () => {
    const request = new FakeRequest()
    const response = new FakeResponse()
    httpRequestMock.mockImplementationOnce((_options, callback) => {
      callback(response)
      return request
    })
    const result = postJsonForJson('http://diagnostics.example/upload', {}, 1000)
    response.emit('data', Buffer.from('{"accepted":'))
    await vi.advanceTimersByTimeAsync(500)
    response.emit('data', Buffer.from('true}'))
    response.emit('end')

    await expect(result).resolves.toEqual({ accepted: true })
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(1000)
    expect(request.destroy).not.toHaveBeenCalled()
    request.emit('close')
    expect(request.eventNames()).toEqual([])
  })
})
