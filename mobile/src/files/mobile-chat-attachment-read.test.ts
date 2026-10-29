import { expect, it, vi } from 'vitest'
import { createMobileChatAttachmentReader } from './mobile-chat-attachment-read'
import { AttachmentTextSource } from '../../../src/shared/attachment-text-source'
import { AGENT_SESSION_TEXT_ATTACHMENT_READ_CAPABILITY } from '../../../src/shared/agent-session-runtime-capabilities'
import type { RpcResponse } from '../transport/types'

it('reads the owning host, validates replies, re-probes on Retry and fences reconnects', async () => {
  let connectedAt = 1
  let capable = false
  const bytes = Buffer.from('\ufeffhello\r\n' + 'x'.repeat(40_000))
  const sendRequest = vi.fn(async (method: string, params?: unknown): Promise<RpcResponse> => {
    if (method === 'status.get') {
      return {
        id: '1',
        ok: true,
        result: { capabilities: capable ? [AGENT_SESSION_TEXT_ATTACHMENT_READ_CAPABILITY] : [] }
      }
    }
    if (
      !params ||
      typeof params !== 'object' ||
      !('offset' in params) ||
      !('length' in params) ||
      typeof params.offset !== 'number' ||
      typeof params.length !== 'number'
    ) {
      throw new Error('Expected a range request')
    }
    const chunk = bytes.subarray(params.offset, params.offset + params.length)
    return {
      id: '1',
      ok: true,
      result: {
        snapshot: 'a'.repeat(64),
        size: bytes.length,
        bytesRead: chunk.length,
        eof: params.offset + chunk.length === bytes.length,
        contentBase64: chunk.toString('base64')
      }
    }
  })
  const read = createMobileChatAttachmentReader({
    sendRequest,
    getState: () => 'connected',
    getLastConnectedAt: () => connectedAt
  })
  const oldHost = new AttachmentTextSource('/host/file.txt', read)
  await expect(oldHost.page(0)).rejects.toThrow('cannot open text attachments yet')
  expect(sendRequest.mock.calls.map(([method]) => method)).toEqual(['status.get'])
  capable = true
  const retried = new AttachmentTextSource('/host/file.txt', read)
  expect((await retried.page(0)).segments.join('')).toMatch(/^\ufeffhello\r\n/)
  expect(await retried.copyText()).toBe(bytes.toString('utf8'))
  connectedAt++
  await expect(retried.copyText()).rejects.toThrow('Connection changed')
  sendRequest.mockResolvedValue({ id: '2', ok: true, result: { contentBase64: 'a' } })
  const replaced = new AttachmentTextSource(
    '/host/file.txt',
    createMobileChatAttachmentReader({
      sendRequest,
      getState: () => 'connected',
      getLastConnectedAt: () => connectedAt
    })
  )
  await expect(replaced.page(0)).rejects.toThrow()
})

it('does not admit a body read after disposal during status and preserves a same-reader Retry successor', async () => {
  for (const count of [1, 10]) {
    const gates = Array.from({ length: count }, () => Promise.withResolvers<RpcResponse>())
    const started = Promise.withResolvers<void>()
    let probes = 0
    const sendRequest = vi.fn(async (method: string): Promise<RpcResponse> => {
      if (method === 'status.get') {
        if (probes < count) {
          const gate = gates[probes++]!
          if (probes === count) {
            started.resolve()
          }
          return gate.promise
        }
        return {
          id: 's',
          ok: true,
          result: { capabilities: [AGENT_SESSION_TEXT_ATTACHMENT_READ_CAPABILITY] },
          _meta: { runtimeId: 'successor' }
        }
      }
      return {
        id: 'b',
        ok: true,
        result: {
          snapshot: 'a'.repeat(64),
          size: 1,
          bytesRead: 1,
          contentBase64: 'eA==',
          eof: true
        },
        _meta: { runtimeId: 'successor' }
      }
    })
    const client = {
      sendRequest,
      getState: () => 'connected' as const,
      getLastConnectedAt: () => 1
    }
    const readers = gates.map(() => createMobileChatAttachmentReader(client))
    const sources = readers.map((read) => new AttachmentTextSource('/file', read))
    const pending = sources.map((source) =>
      source.page(0).then(
        () => false,
        () => true
      )
    )
    await started.promise
    sources.forEach((source) => source.dispose())
    const successors = readers.map((read) => new AttachmentTextSource('/file', read))
    await Promise.all(successors.map((source) => source.page(0)))
    const bodiesBefore = sendRequest.mock.calls.filter(([method]) => method !== 'status.get').length
    expect(bodiesBefore).toBe(count)
    gates.forEach((gate) =>
      gate.resolve({
        id: 's',
        ok: true,
        result: { capabilities: [AGENT_SESSION_TEXT_ATTACHMENT_READ_CAPABILITY] },
        _meta: { runtimeId: 'disposed' }
      })
    )
    expect(await Promise.all(pending)).toEqual(Array(count).fill(true))
    expect(sendRequest.mock.calls.filter(([method]) => method !== 'status.get')).toHaveLength(
      bodiesBefore
    )
    expect(await Promise.all(successors.map((source) => source.copyText()))).toEqual(
      Array(count).fill('x')
    )
  }
})
