import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import type { callRuntimeEnvironment as callRuntimeEnvironmentTransport } from '../ipc/runtime-environments/runtime-environment-transport-routing'

const { callRuntimeEnvironment } = vi.hoisted(() => ({
  callRuntimeEnvironment: vi.fn<typeof callRuntimeEnvironmentTransport>()
}))
vi.mock('../ipc/runtime-environments/runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment
}))
vi.mock('../ipc/runtime-environments/runtime-environment-registry-root', () => ({
  getRuntimeEnvironmentRegistryRoot: () => '/user-data'
}))

import {
  REMOTE_PREVIEW_UPDATE_REQUIRED_MESSAGE,
  RemotePreviewPairingChangedError,
  assertRemoteChunkReadsSupported,
  readRemotePreviewRange,
  readRemotePreviewChunk,
  statRemotePreviewFile
} from './remote-file-preview-reader'

const address = {
  environmentId: 'env-1',
  worktree: 'id:wt-1',
  relativePath: 'out/clip.mp4',
  expectedEnvironmentPairingRevision: 7
}
const ok = (result: unknown): RuntimeRpcResponse<unknown> => ({
  id: 'preview-response',
  ok: true,
  result,
  _meta: { runtimeId: 'paired-runtime' }
})
const fail = (code: string, message: string): RuntimeRpcResponse<unknown> => ({
  id: 'preview-response',
  ok: false,
  error: { code, message }
})
const probeResponse = ok({ contentBase64: 'AA==', bytesRead: 1, eof: false })

function controlChunkCalls() {
  const calls: {
    signal: AbortSignal
    resolve: (response: RuntimeRpcResponse<unknown>) => void
    reject: (error: Error) => void
    rejectOnAbort: boolean
  }[] = []
  callRuntimeEnvironment.mockImplementation(
    (_root, _environment, _method, _params, _timeout, _revision, _envelope, options) => {
      const signal = options?.signal
      if (!signal) {
        throw new Error('Expected an abortable request')
      }
      const response = Promise.withResolvers<RuntimeRpcResponse<unknown>>()
      const call = {
        signal,
        resolve: response.resolve,
        reject: response.reject,
        rejectOnAbort: true
      }
      const abort = () => {
        if (call.rejectOnAbort) {
          response.reject(signal.reason)
        }
      }
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) {
        abort()
      }
      calls.push(call)
      return response.promise.finally(() => signal.removeEventListener('abort', abort))
    }
  )
  return calls
}

function lastChunkCall(calls: ReturnType<typeof controlChunkCalls>) {
  const call = calls.at(-1)
  if (!call) {
    throw new Error('Expected a pending chunk request')
  }
  return call
}

describe('remote file preview reader', () => {
  const signal = new AbortController().signal
  beforeEach(() => {
    callRuntimeEnvironment.mockReset()
  })

  it('stats the file through its pinned pairing', async () => {
    callRuntimeEnvironment.mockResolvedValue(
      ok({ size: 6, isDirectory: false, mtime: 1, ctime: 2 })
    )
    await expect(statRemotePreviewFile(address, signal)).resolves.toEqual({
      size: 6,
      mtime: 1,
      ctime: 2
    })
    expect(callRuntimeEnvironment).toHaveBeenCalledWith(
      '/user-data',
      'env-1',
      'files.stat',
      { worktree: 'id:wt-1', relativePath: 'out/clip.mp4' },
      15_000,
      7,
      undefined,
      { signal }
    )
  })

  it('refuses a directory', async () => {
    callRuntimeEnvironment.mockResolvedValue(ok({ size: 0, isDirectory: true, mtime: 1 }))
    await expect(statRemotePreviewFile(address, signal)).rejects.toThrow('directory')
  })

  it('decodes a chunk and refuses one whose length disagrees', async () => {
    callRuntimeEnvironment.mockResolvedValueOnce(
      ok({ contentBase64: 'AAECAw==', bytesRead: 4, eof: false })
    )
    await expect(readRemotePreviewChunk(address, 10, 4, signal)).resolves.toEqual(
      new Uint8Array([0, 1, 2, 3])
    )
    callRuntimeEnvironment.mockResolvedValueOnce(
      ok({ contentBase64: 'AAE=', bytesRead: 4, eof: false })
    )
    await expect(readRemotePreviewChunk(address, 0, 4, signal)).rejects.toThrow('corrupted')
  })

  it('tells the user to update a host without range reads', async () => {
    callRuntimeEnvironment.mockResolvedValue(fail('method_not_found', 'x'))
    await expect(statRemotePreviewFile(address, signal)).rejects.toThrow(
      REMOTE_PREVIEW_UPDATE_REQUIRED_MESSAGE
    )
  })

  it('reports a re-paired environment as a dead pairing, not a transient failure', async () => {
    callRuntimeEnvironment.mockResolvedValue(fail('runtime_environment_changed', 'changed'))
    await expect(readRemotePreviewChunk(address, 0, 1, signal)).rejects.toBeInstanceOf(
      RemotePreviewPairingChangedError
    )
  })

  it('proves chunk reads with one byte once per pairing, and re-proves after a re-pair', async () => {
    callRuntimeEnvironment.mockResolvedValue(
      ok({ contentBase64: 'AA==', bytesRead: 1, eof: false })
    )
    const pinned = { ...address, environmentId: 'env-probe' }
    await assertRemoteChunkReadsSupported(pinned, signal)
    await assertRemoteChunkReadsSupported(pinned, signal)
    expect(callRuntimeEnvironment).toHaveBeenCalledTimes(1)
    expect(callRuntimeEnvironment).toHaveBeenCalledWith(
      '/user-data',
      'env-probe',
      'files.readChunk',
      expect.objectContaining({ offset: 0, length: 1 }),
      20_000,
      7,
      undefined,
      { signal: expect.any(AbortSignal) }
    )
    await assertRemoteChunkReadsSupported(
      { ...pinned, expectedEnvironmentPairingRevision: 8 },
      signal
    )
    expect(callRuntimeEnvironment).toHaveBeenCalledTimes(2)
  })

  it('never caches a verdict no pairing revision pins', async () => {
    callRuntimeEnvironment.mockResolvedValue(
      ok({ contentBase64: 'AA==', bytesRead: 1, eof: false })
    )
    const unpinned = { environmentId: 'env-unpinned', worktree: 'id:wt-1', relativePath: 'a.mp4' }
    await assertRemoteChunkReadsSupported(unpinned, signal)
    await assertRemoteChunkReadsSupported(unpinned, signal)
    expect(callRuntimeEnvironment).toHaveBeenCalledTimes(2)
  })

  it('retires overlapping cold probes after a healthy sibling, without canceling PDF content', async () => {
    const calls = controlChunkCalls()
    const pinned = { ...address, environmentId: 'env-overlap' }
    const probes = Array.from({ length: 12 }, (_, index) =>
      assertRemoteChunkReadsSupported({ ...pinned, relativePath: `${index}.mp4` }, signal)
    )
    const prefix = readRemotePreviewRange(
      { ...pinned, relativePath: 'document.pdf' },
      0,
      8,
      100,
      signal
    )
    calls[1].resolve(probeResponse)
    await probes[1]
    expect(calls.slice(0, 12).filter((call) => call.signal.aborted)).toHaveLength(11)
    expect(calls[12].signal.aborted).toBe(false)
    await Promise.all(probes)
    calls[12].resolve(
      ok({ contentBase64: Buffer.from('%PDF-1.7').toString('base64'), bytesRead: 8, eof: false })
    )
    expect(Buffer.from(await prefix).toString()).toBe('%PDF-1.7')
    await assertRemoteChunkReadsSupported(pinned, signal)
    expect(calls).toHaveLength(13)
  })

  it.each([
    ['path failure', fail('not_found', 'missing file'), 'missing file'],
    ['pairing failure', fail('runtime_environment_changed', 'pairing changed'), 'pairing changed'],
    ['malformed chunk', ok({ bytesRead: 1 }), 'unreadable file chunk'],
    ['corrupt chunk', ok({ contentBase64: '', bytesRead: 1, eof: false }), 'corrupted file chunk']
  ] as const)(
    'preserves an independent %s before sibling confirmation',
    async (_name, response, message) => {
      const calls = controlChunkCalls()
      const pinned = { ...address, environmentId: `env-error-${_name}` }
      const failed = assertRemoteChunkReadsSupported({ ...pinned, relativePath: 'bad.mp4' }, signal)
      const healthy = assertRemoteChunkReadsSupported(pinned, signal)
      calls[0].resolve(response)
      await expect(failed).rejects.toThrow(message)
      expect(calls[1].signal.aborted).toBe(false)
      calls[1].resolve(probeResponse)
      await healthy
    }
  )

  it('does not mistake a transport AbortError for sibling confirmation', async () => {
    const calls = controlChunkCalls()
    const pinned = { ...address, environmentId: 'env-transport-abort' }
    const failed = assertRemoteChunkReadsSupported(pinned, signal)
    const healthy = assertRemoteChunkReadsSupported(pinned, signal)
    const error = new DOMException('Range reads are supported.', 'AbortError')
    calls[0].reject(error)
    await expect(failed).rejects.toBe(error)
    expect(calls[1].signal.aborted).toBe(false)
    calls[1].resolve(probeResponse)
    await healthy
  })

  it('preserves caller aborts before and during confirmation while a sibling succeeds', async () => {
    const calls = controlChunkCalls()
    const pinned = { ...address, environmentId: 'env-owner-aborts' }
    const first = new AbortController()
    const second = new AbortController()
    const firstReason = new Error('first owner closed')
    const secondReason = new Error('second owner closed')
    const firstProbe = assertRemoteChunkReadsSupported(pinned, first.signal)
    const firstRejected = expect(firstProbe).rejects.toBe(firstReason)
    const secondProbe = assertRemoteChunkReadsSupported(pinned, second.signal)
    const secondSettled = Promise.allSettled([secondProbe])
    const healthy = assertRemoteChunkReadsSupported(pinned, signal)
    first.abort(firstReason)
    await firstRejected
    expect(calls[1].signal.aborted).toBe(false)
    calls[1].signal.addEventListener('abort', () => second.abort(secondReason), { once: true })
    calls[2].resolve(probeResponse)
    await healthy
    expect(calls[1].signal.aborted).toBe(true)
    expect(await secondSettled).toEqual([{ status: 'rejected', reason: secondReason }])
  })

  it('does not cache a successful response whose caller aborted before publication', async () => {
    const calls = controlChunkCalls()
    const pinned = { ...address, environmentId: 'env-aborted-success' }
    const owner = new AbortController()
    const reason = new Error('owner closed before publication')
    const abandoned = assertRemoteChunkReadsSupported(pinned, owner.signal)
    const rejected = expect(abandoned).rejects.toBe(reason)
    calls[0].resolve(probeResponse)
    owner.abort(reason)
    await rejected
    const retry = assertRemoteChunkReadsSupported(pinned, signal)
    expect(calls).toHaveLength(2)
    calls[1].resolve(probeResponse)
    await retry
  })

  it('allows a fresh same-key group after every owner aborts', async () => {
    const calls = controlChunkCalls()
    const pinned = { ...address, environmentId: 'env-all-aborted' }
    const owners = [new AbortController(), new AbortController()]
    const results = Promise.allSettled(
      owners.map((owner) => assertRemoteChunkReadsSupported(pinned, owner.signal))
    )
    const reason = new Error('all owners closed')
    for (const owner of owners) {
      owner.abort(reason)
    }
    expect(await results).toEqual(owners.map(() => ({ status: 'rejected', reason })))
    const first = assertRemoteChunkReadsSupported(pinned, signal)
    const second = assertRemoteChunkReadsSupported(pinned, signal)
    expect(calls).toHaveLength(4)
    calls[3].resolve(probeResponse)
    await second
    expect(calls[2].signal.aborted).toBe(true)
    await first
  })

  it('isolates pending probes by environment and pairing revision', async () => {
    const calls = controlChunkCalls()
    const pinned = { ...address, environmentId: 'env-isolated' }
    const samePairing = [
      assertRemoteChunkReadsSupported(pinned, signal),
      assertRemoteChunkReadsSupported({ ...pinned, relativePath: 'sibling.mp4' }, signal)
    ]
    const nextPairing = assertRemoteChunkReadsSupported(
      { ...pinned, expectedEnvironmentPairingRevision: 8 },
      signal
    )
    const nextEnvironment = assertRemoteChunkReadsSupported(
      { ...pinned, environmentId: 'env-isolated-other' },
      signal
    )
    calls[1].resolve(probeResponse)
    await samePairing[1]
    expect(calls.map((call) => call.signal.aborted)).toEqual([true, false, false, false])
    calls[2].resolve(probeResponse)
    calls[3].resolve(probeResponse)
    await Promise.all([...samePairing, nextPairing, nextEnvironment])
  })

  it('keeps late retired responses from restoring an evicted verdict or removing a new group', async () => {
    const calls = controlChunkCalls()
    const pinned = { ...address, environmentId: 'env-late-generation' }
    const late = assertRemoteChunkReadsSupported(pinned, signal)
    calls[0].rejectOnAbort = false
    const winner = assertRemoteChunkReadsSupported(pinned, signal)
    calls[1].resolve(probeResponse)
    await winner
    expect(calls[0].signal.aborted).toBe(true)
    for (let index = 0; index < 65; index++) {
      const churn = assertRemoteChunkReadsSupported(
        { ...pinned, environmentId: `env-verdict-churn-${index}` },
        signal
      )
      lastChunkCall(calls).resolve(probeResponse)
      await churn
    }
    const fresh = assertRemoteChunkReadsSupported(pinned, signal)
    const freshCall = lastChunkCall(calls)
    calls[0].resolve(probeResponse)
    await late
    const count = calls.length
    const sibling = assertRemoteChunkReadsSupported(pinned, signal)
    expect(calls).toHaveLength(count + 1)
    lastChunkCall(calls).resolve(probeResponse)
    await sibling
    expect(freshCall.signal.aborted).toBe(true)
    await fresh
  })

  it('tells the user to update a host that answers files.stat but not files.readChunk', async () => {
    callRuntimeEnvironment.mockResolvedValue(fail('method_not_found', 'x'))
    await expect(
      assertRemoteChunkReadsSupported({ ...address, environmentId: 'env-old' }, signal)
    ).rejects.toThrow(REMOTE_PREVIEW_UPDATE_REQUIRED_MESSAGE)
  })

  it('reads a range in host-sized chunks, clipped to the file and stopping at EOF', async () => {
    callRuntimeEnvironment
      .mockResolvedValueOnce(
        ok({
          contentBase64: Buffer.alloc(262_144, 1).toString('base64'),
          bytesRead: 262_144,
          eof: false
        })
      )
      .mockResolvedValueOnce(ok({ contentBase64: 'AQID', bytesRead: 3, eof: true }))
    const range = await readRemotePreviewRange(address, 10, 900_000, 262_157, signal)
    expect(range.byteLength).toBe(262_147)
    expect(callRuntimeEnvironment.mock.calls[0]?.[3]).toMatchObject({ offset: 10, length: 262_144 })
    expect(callRuntimeEnvironment.mock.calls[1]?.[3]).toMatchObject({ offset: 262_154, length: 3 })
  })
})
