import { expect, it, vi } from 'vitest'
import { createMobileChatAttachmentReader } from './mobile-chat-attachment-read'
import { AttachmentTextSource } from '../../../src/shared/attachment-text-source'
import { AGENT_SESSION_TEXT_ATTACHMENT_READ_CAPABILITY } from '../../../src/shared/agent-session-runtime-capabilities'
import { RpcClientRequestTracker } from '../transport/rpc-client-request-tracker'
import { RpcClientConnectionState } from '../transport/rpc-client-connection-state'
import { createStableLogicalRpcClient } from '../transport/stable-logical-rpc-client'
import { scopeRpcClientToExecutionHost } from '../transport/execution-host-scoped-rpc-client'
import type { SendRequestOptions } from '../transport/rpc-client'
import type { RpcRequestFrame } from '../transport/rpc-envelope-fields'

function fixture() {
  const state = new RpcClientConnectionState({
    endpoint: 'ws://test35636',
    getReconnectAttempt: () => 0,
    isClosed: () => false
  })
  state.publish('connected')
  const frames: RpcRequestFrame[] = []
  const control: {
    capable: boolean
    holdStatus: boolean
    holdBody: boolean
    atConnected: (() => void) | undefined
    body: unknown
  } = {
    capable: true,
    holdStatus: false,
    holdBody: false,
    atConnected: undefined,
    body: {
      snapshot: 'a'.repeat(64),
      size: 1,
      bytesRead: 1,
      contentBase64: 'eA==',
      eof: true
    }
  }
  let serial = 0
  let currentMethod = ''
  const answer = (frame: RpcRequestFrame, runtimeId = 'successor') =>
    tracker.resolve({
      id: frame.id,
      ok: true,
      result:
        frame.method === 'status.get'
          ? { capabilities: control.capable ? [AGENT_SESSION_TEXT_ATTACHMENT_READ_CAPABILITY] : [] }
          : control.body,
      _meta: { runtimeId }
    })
  const tracker = new RpcClientRequestTracker({
    nextId: () => String(++serial),
    getState: () => state.get(),
    waitForConnected: (timeout) => {
      const connected = state.waitForConnected(timeout)
      return currentMethod === 'agentSessionAttachment.readTextChunk' && control.atConnected
        ? connected.then(control.atConnected)
        : connected
    },
    sendFrame: (frame) => {
      frames.push(frame)
      if (!(frame.method === 'status.get' ? control.holdStatus : control.holdBody)) {
        queueMicrotask(() => answer(frame))
      }
      return true
    }
  })
  const physical = {
    sendRequest: (method: string, params?: unknown, options?: SendRequestOptions) => {
      currentMethod = method
      return tracker.sendRequest(method, params, options)
    },
    getState: () => state.get(),
    getLastConnectedAt: () => state.getLastConnectedAt(),
    getReconnectAttempt: () => 0,
    onStateChange: (listener: Parameters<typeof state.addListener>[0]) =>
      state.addListener(listener),
    notifyForeground: () => {},
    close: () => tracker.rejectAll('closed'),
    subscribe: () => () => {},
    updateTerminalSubscriptionViewport: () => {}
  }
  const logical = createStableLogicalRpcClient(physical, 'lan')
  const client = scopeRpcClientToExecutionHost(logical, 'runtime:server35636')
  const source = (read = createMobileChatAttachmentReader(client)) =>
    new AttachmentTextSource('/source35636', read)
  const bodyCount = () =>
    frames.filter((frame) => frame.method === 'agentSessionAttachment.readTextChunk').length
  return { state, frames, control, answer, tracker, physical, logical, client, source, bodyCount }
}

it.each([1, 10])(
  'settles %s abandoned status waiters before release and keeps same-reader successors pinned',
  async (count) => {
    const f = fixture()
    f.control.holdStatus = true
    const readers = Array.from({ length: count }, () => createMobileChatAttachmentReader(f.client))
    const old = readers.map(f.source)
    const pending = old.map((source) => source.page(0).catch((error) => error))
    await vi.waitFor(() => expect(f.frames).toHaveLength(count))
    const held = [...f.frames]
    old.forEach((source) => source.dispose())
    expect((await Promise.all(pending)).map((error) => error.name)).toEqual(
      Array(count).fill('AbortError')
    )
    expect(f.tracker.size()).toBe(0)
    f.control.holdStatus = false
    const successors = readers.map(f.source)
    await Promise.all(successors.map((source) => source.page(0)))
    expect(f.bodyCount()).toBe(count)
    held.forEach((frame) => expect(f.answer(frame, 'disposed')).toBe(false))
    expect(f.bodyCount()).toBe(count)
    expect(await Promise.all(successors.map((source) => source.copyText()))).toEqual(
      Array(count).fill('x')
    )
    expect(f.frames.every((frame) => !('signal' in frame) && !('beforeSend' in frame))).toBe(true)
    expect(
      f.frames.every(
        (frame) =>
          JSON.stringify(frame.envelope) ===
          JSON.stringify({ executionHost: 'runtime:server35636' })
      )
    ).toBe(true)
    successors.forEach((source) => source.dispose())
    f.logical.close()
  }
)

it('preserves old-host Retry, malformed reply refusal, final-send ownership and reconnect through the real client', async () => {
  const f = fixture()
  const read = createMobileChatAttachmentReader(f.client)
  f.control.capable = false
  await expect(f.source(read).page(0)).rejects.toThrow('cannot open text attachments yet')
  expect(f.frames.map((frame) => frame.method)).toEqual(['status.get'])
  f.control.capable = true
  expect(await f.source(read).copyText()).toBe('x')
  const old = f.source(read)
  f.control.atConnected = () => {
    f.control.atConnected = undefined
    old.dispose()
  }
  const before = f.bodyCount()
  await expect(old.copyText()).rejects.toMatchObject({ name: 'AbortError' })
  expect(f.bodyCount()).toBe(before)
  const retry = f.source(read)
  expect(await retry.copyText()).toBe('x')
  f.control.atConnected = () => {
    f.control.atConnected = undefined
    return f.logical.migrateTo({ ...f.physical }, 'lan')
  }
  const beforeMigration = f.bodyCount()
  await expect(f.source(read).copyText()).rejects.toThrow('RPC interrupted by connection migration')
  expect(f.bodyCount()).toBe(beforeMigration)
  await expect(retry.copyText()).rejects.toThrow('Connection changed')
  f.control.atConnected = () => {
    f.control.atConnected = undefined
    f.state.publish('disconnected')
  }
  await expect(f.source().copyText()).rejects.toThrow('Not connected')
  expect(f.bodyCount()).toBe(beforeMigration)
  f.state.publish('connected')
  expect(await f.source().copyText()).toBe('x')
  f.control.body = { contentBase64: 'a' }
  await expect(f.source().page(0)).rejects.toThrow()
  f.control.holdBody = true
  const admitted = f.source()
  const pending = admitted.copyText().catch((error) => error)
  await vi.waitFor(() => expect(f.tracker.size()).toBe(1))
  const late = f.frames.at(-1)!
  admitted.dispose()
  expect((await pending).name).toBe('AbortError')
  expect(f.tracker.size()).toBe(0)
  expect(f.answer(late)).toBe(false)
  retry.dispose()
  f.logical.close()
})
