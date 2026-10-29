import { beforeEach, expect, it } from 'vitest'
import { importRuntimeImage } from './runtime-image-import-client'
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'
import {
  FileCommitUpload,
  FileDelete,
  FileWriteBase64Chunk
} from '../../../shared/rpc-contract/files-mutation-params'
import {
  installRuntimeFileClientEnvironment,
  runtimeEnvironmentCall,
  fsImportExternalPaths,
  fsStageExternalPathsForRuntimeUpload,
  fsUploadExternalFileToRuntime
} from './runtime-file-client-test-harness'

installRuntimeFileClientEnvironment()

const files = new Map<string, Buffer>()
const context = {
  target: { kind: 'environment', environmentId: 'image-owner' } as const,
  worktreeId: 'wt-1',
  worktreePath: '/remote/repo',
  expectedExecutionHostId: 'ssh:target' as const,
  expectedSshTargetId: 'target',
  expectedSshConnectionGeneration: 7
}
const options = () => ({ signal: new AbortController().signal, assertCurrent: () => {} })

beforeEach(() => {
  files.clear()
  runtimeEnvironmentCall.mockImplementation(async ({ method, params }) => {
    if (method === 'files.stat') {
      return { ok: false, error: { code: 'not_found', message: 'not found' } }
    }
    if (method === 'files.writeBase64Chunk') {
      const request = FileWriteBase64Chunk.parse(params)
      const previous = request.append ? files.get(request.relativePath) : undefined
      files.set(
        request.relativePath,
        Buffer.concat([previous ?? Buffer.alloc(0), Buffer.from(request.contentBase64, 'base64')])
      )
    } else if (method === 'files.commitUpload') {
      const request = FileCommitUpload.parse(params)
      const bytes = files.get(request.tempRelativePath)
      if (!bytes || files.has(request.finalRelativePath)) {
        throw new Error('Invalid commit')
      }
      files.set(request.finalRelativePath, bytes)
      files.delete(request.tempRelativePath)
    } else if (method === 'files.delete') {
      files.delete(FileDelete.parse(params).relativePath)
    } else {
      throw new Error(`Unexpected method: ${method}`)
    }
    return { ok: true, result: { ok: true }, _meta: { runtimeId: 'remote-runtime' } }
  })
})

it.each(['wt-1', 'folder:folder-1'])(
  'writes exact image bytes on the owning runtime for %s',
  async (worktreeId) => {
    const bytes = Buffer.alloc(400_001, 0xfb)
    const path = await importRuntimeImage(
      { ...context, worktreeId },
      bytes.toString('base64'),
      '/remote/repo/notes',
      options()
    )
    expect(files.size).toBe(1)
    expect(files.get(path.slice('/remote/repo/'.length))).toEqual(bytes)
    expect([...files.keys()].some((key) => key.includes('.orca-upload-'))).toBe(false)
    const mutations = runtimeEnvironmentCall.mock.calls
      .map(([request]) => request)
      .filter((request) => request.method !== 'files.stat')
    expect(mutations.filter((request) => request.method === 'files.writeBase64Chunk')).toHaveLength(
      2
    )
    for (const request of mutations) {
      expect(request).toMatchObject({
        selector: 'image-owner',
        expectedEnvironmentRuntimeId: 'remote-runtime',
        params: {
          expectedExecutionHostId: 'ssh:target',
          expectedSshTargetId: 'target',
          expectedSshConnectionGeneration: 7
        }
      })
    }
    expect(fsImportExternalPaths).not.toHaveBeenCalled()
    expect(fsStageExternalPathsForRuntimeUpload).not.toHaveBeenCalled()
    expect(fsUploadExternalFileToRuntime).not.toHaveBeenCalled()
  }
)

it('cleans up a rejected old-server upload without a local path fallback or destination commit', async () => {
  const server = runtimeEnvironmentCall.getMockImplementation()
  runtimeEnvironmentCall.mockImplementation(async (request) =>
    request.method === 'files.writeBase64Chunk'
      ? { ok: false, error: { code: 'method_not_found', message: 'Image upload unsupported' } }
      : server?.(request)
  )
  await expect(
    importRuntimeImage(context, 'YWJj', '/remote/repo/notes', options())
  ).rejects.toThrow('Image upload unsupported')
  expect(files.size).toBe(0)
  const methods = runtimeEnvironmentCall.mock.calls.map(([request]) => request.method)
  expect(methods).not.toContain('files.commitUpload')
  expect(methods.at(-1)).toBe('files.delete')
  expect(fsImportExternalPaths).not.toHaveBeenCalled()
})

it('stops before another chunk or commit when the owning server is re-paired', async () => {
  const server = runtimeEnvironmentCall.getMockImplementation()
  runtimeEnvironmentCall.mockImplementation(async (request) => {
    const result = await server?.(request)
    if (request.method === 'files.writeBase64Chunk') {
      replaceRuntimeEnvironmentRevisions([{ id: 'image-owner', createdAt: 1, pairingRevision: 2 }])
    }
    return result
  })
  await expect(
    importRuntimeImage(
      context,
      Buffer.alloc(400_001).toString('base64'),
      '/remote/repo/notes',
      options()
    )
  ).rejects.toThrow('pairing changed')
  expect(
    runtimeEnvironmentCall.mock.calls.filter(
      ([request]) => request.method === 'files.writeBase64Chunk'
    )
  ).toHaveLength(1)
  expect(
    runtimeEnvironmentCall.mock.calls.some(([request]) => request.method === 'files.commitUpload')
  ).toBe(false)
})
