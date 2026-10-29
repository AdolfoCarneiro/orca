// @vitest-environment happy-dom
import { Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import { Markdown } from '@tiptap/markdown'
import { DOMParser } from '@tiptap/pm/model'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type * as ImageBlobPng from '@/lib/image-blob-png'
import { handleRichMarkdownPaste } from './rich-markdown-paste-handler'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import { clearRuntimeCompatibilityCacheForTests } from '@/runtime/runtime-rpc-client'
import type { RuntimeRpcRequest } from '@/runtime/runtime-file-client-test-harness'
import {
  FileCommitUpload,
  FileDelete,
  FileWriteBase64Chunk
} from '../../../../shared/rpc-contract/files-mutation-params'
import {
  FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY,
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../../shared/protocol-version'

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      settings: null,
      folderWorkspaces: [{ id: 'notes', folderPath: '/repo' }],
      worktreesByRepo: {},
      openFiles: []
    })
  }
}))
vi.mock('@/lib/connection-context', () => ({ getConnectionId: () => null }))
vi.mock('@/lib/image-blob-png', async (original) => ({
  ...(await original<typeof ImageBlobPng>()),
  convertImageBlobToPng: async (blob: Blob) => blob
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn() } }))

let editor: Editor
let runtimeId = 'original-runtime'
let afterCommit = (): void => {}
const files = new Map<string, Map<string, Buffer>>()
const remoteCall = vi.fn(async (request: RuntimeRpcRequest) => {
  const runtimeFiles = files.get(runtimeId)
  if (!runtimeFiles) {
    throw new Error('Missing runtime filesystem')
  }
  let result: unknown = { ok: true }
  if (request.method === 'status.get') {
    result = {
      runtimeId,
      runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
      minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
      capabilities: [FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY]
    }
  } else if (request.method === 'files.stat') {
    return { ok: false, error: { code: 'not_found', message: 'not found' } }
  } else if (request.method === 'files.writeBase64Chunk') {
    const args = FileWriteBase64Chunk.parse(request.params)
    runtimeFiles.set(
      args.relativePath,
      Buffer.concat([
        (args.append ? runtimeFiles.get(args.relativePath) : undefined) ?? Buffer.alloc(0),
        Buffer.from(args.contentBase64, 'base64')
      ])
    )
  } else if (request.method === 'files.commitUpload') {
    const args = FileCommitUpload.parse(request.params)
    const bytes = runtimeFiles.get(args.tempRelativePath)
    if (!bytes || runtimeFiles.has(args.finalRelativePath)) {
      throw new Error('Invalid commit')
    }
    runtimeFiles.set(args.finalRelativePath, bytes)
    runtimeFiles.delete(args.tempRelativePath)
    afterCommit()
  } else if (request.method === 'files.delete') {
    runtimeFiles.delete(FileDelete.parse(request.params).relativePath)
  } else {
    throw new Error(`Unexpected method: ${request.method}`)
  }
  return { ok: true, result, _meta: { runtimeId } }
})

function replaceOwner(): void {
  runtimeId = 'replacement-runtime'
  replaceRuntimeEnvironmentRevisions([{ id: 'paste-owner', createdAt: 1, pairingRevision: 2 }], {
    retired: ['paste-owner'],
    sameHost: []
  })
}

function paste(): void {
  const html = '<p>caption <img src="blob:first"> between <img src="blob:second"> tail</p>'
  const container = document.createElement('div')
  container.innerHTML = html
  const slice = DOMParser.fromSchema(editor.schema).parseSlice(container)
  const clipboardData = new DataTransfer()
  clipboardData.setData('text/html', html)
  expect(
    handleRichMarkdownPaste({
      editor,
      event: new ClipboardEvent('paste', { clipboardData, cancelable: true }),
      filePath: '/repo/note.md',
      worktreeId: 'folder:notes',
      runtimeEnvironmentId: 'paste-owner',
      slice,
      view: editor.view
    })
  ).toBe(true)
}

async function settled(): Promise<void> {
  await vi.waitFor(() => {
    expect(
      editor.getMarkdown() !== 'left right' || vi.mocked(toast.error).mock.calls.length > 0
    ).toBe(true)
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  clearRuntimeCompatibilityCacheForTests()
  runtimeId = 'original-runtime'
  afterCommit = () => {}
  files.clear()
  files.set(runtimeId, new Map())
  files.set('replacement-runtime', new Map())
  replaceRuntimeEnvironmentRevisions([{ id: 'paste-owner', createdAt: 1, pairingRevision: 1 }])
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { runtimeEnvironments: { call: remoteCall } }
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (src: string) => ({
      ok: true,
      blob: async () => new Blob([src], { type: 'image/png' })
    }))
  )
  const element = document.createElement('div')
  document.body.append(element)
  editor = new Editor({
    element,
    extensions: [StarterKit, Image.configure({ inline: true }), Markdown],
    content: 'left right',
    contentType: 'markdown'
  })
  editor.commands.setTextSelection(6)
})

afterEach(() => {
  editor.destroy()
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

it('keeps both durable image files on the captured runtime when its pairing stays stable', async () => {
  paste()
  await settled()
  expect(
    [...(files.get('original-runtime')?.values() ?? [])].map((bytes) => bytes.toString())
  ).toEqual(['blob:first', 'blob:second'])
  expect(files.get('replacement-runtime')?.size).toBe(0)
  expect(editor.getMarkdown()).not.toContain('blob:')
  expect(toast.error).not.toHaveBeenCalled()
})

it.each(['reading', 'between images'])('refuses a replacement runtime while %s', async (phase) => {
  const reading = Promise.withResolvers<void>()
  const started = Promise.withResolvers<void>()
  if (phase === 'reading') {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (src: string) => ({
        ok: true,
        blob: async () => {
          if (src === 'blob:first') {
            started.resolve()
            await reading.promise
          }
          return new Blob([src], { type: 'image/png' })
        }
      }))
    )
  } else {
    afterCommit = replaceOwner
  }
  paste()
  if (phase === 'reading') {
    await started.promise
    replaceOwner()
    reading.resolve()
  }
  await settled()
  expect(files.get('replacement-runtime')?.size).toBe(0)
  expect(editor.getMarkdown()).toBe('left right')
  expect(toast.error).toHaveBeenCalledOnce()
})
