// @vitest-environment happy-dom
import { Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import { Markdown } from '@tiptap/markdown'
import { DOMParser } from '@tiptap/pm/model'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type * as ImageBlobPng from '@/lib/image-blob-png'
import type { RuntimeRpcRequest } from '@/runtime/runtime-file-client-test-harness'
import { clearRuntimeCompatibilityCacheForTests } from '@/runtime/runtime-rpc-client'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import { setRuntimeEnvironmentConnectionGenerationForTests } from '@/store/slices/runtime-status'
import { FileOpen } from '../../../../shared/rpc-contract/files-target-params'
import {
  FileCommitUpload,
  FileDelete,
  FileWriteBase64Chunk
} from '../../../../shared/rpc-contract/files-mutation-params'
import { SaveImageAsTempFile } from '../../../../shared/rpc-contract/clipboard-params'
import {
  FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY,
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../../shared/protocol-version'
import { handleRichMarkdownPaste } from './rich-markdown-paste-handler'
import { RichMarkdownImageClipboard } from './rich-markdown-image-clipboard'
import { handleRichMarkdownImageDrop } from './rich-markdown-image-drop'
import { setRichMarkdownImageResolverContext } from './rich-markdown-image-context'

const sshState = vi.hoisted(() => ({ generation: 1 }))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      settings: null,
      sshConnectionStates: new Map([['source-ssh', { connectionGeneration: sshState.generation }]]),
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
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() }
}))

const editors: Editor[] = []
const incarnations = new Map<string, string>()
const revisions = new Map<string, number>()
const files = new Map<string, Map<string, Buffer>>()
let beforeRead = async (): Promise<void> => {}
let mutationCapable = true
const remoteCall = vi.fn(async (request: RuntimeRpcRequest) => {
  const runtimeId = incarnations.get(request.selector ?? '')
  const filesystem = runtimeId ? files.get(runtimeId) : undefined
  if (!filesystem) {
    throw new Error('Unknown runtime')
  }
  let result: unknown = { ok: true }
  if (request.method === 'status.get') {
    result = {
      runtimeId,
      runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
      minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
      capabilities: mutationCapable ? [FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY] : []
    }
  } else if (request.method === 'files.readPreview') {
    const args = FileOpen.parse(request.params)
    const bytes = filesystem.get(args.relativePath)
    if (!bytes) {
      throw new Error('Missing original source bytes')
    }
    await beforeRead()
    result = { isBinary: true, content: bytes.toString('base64'), mimeType: 'image/png' }
  } else if (request.method === 'files.stat') {
    return { ok: false, error: { code: 'not_found', message: 'not found' } }
  } else if (request.method === 'files.writeBase64Chunk') {
    const args = FileWriteBase64Chunk.parse(request.params)
    filesystem.set(
      args.relativePath,
      Buffer.concat([
        (args.append ? filesystem.get(args.relativePath) : undefined) ?? Buffer.alloc(0),
        Buffer.from(args.contentBase64, 'base64')
      ])
    )
  } else if (request.method === 'files.commitUpload') {
    const args = FileCommitUpload.parse(request.params)
    const bytes = filesystem.get(args.tempRelativePath)
    if (!bytes || filesystem.has(args.finalRelativePath)) {
      throw new Error('Invalid commit')
    }
    filesystem.set(args.finalRelativePath, bytes)
    filesystem.delete(args.tempRelativePath)
  } else if (request.method === 'files.delete') {
    filesystem.delete(FileDelete.parse(request.params).relativePath)
  } else {
    throw new Error(request.method)
  }
  return { ok: true, result, _meta: { runtimeId } }
})
const localFiles = new Map<string, Buffer>()
const sshFiles = new Map<string, Buffer>()
const readLocal = vi.fn(
  async ({ filePath, connectionId }: { filePath: string; connectionId?: string }) => {
    if (connectionId && connectionId !== 'source-ssh') {
      throw new Error('Unexpected SSH target')
    }
    const bytes = (connectionId ? sshFiles : localFiles).get(filePath)
    if (!bytes) {
      throw new Error('Missing local source bytes')
    }
    await beforeRead()
    return { isBinary: true, content: bytes.toString('base64'), mimeType: 'image/png' }
  }
)
const saveLocal = vi.fn(async (request: RuntimeRpcRequest) => {
  const args = SaveImageAsTempFile.parse(request.params)
  localFiles.set('/tmp/copied.png', Buffer.from(args.contentBase64, 'base64'))
  return { ok: true, result: '/tmp/copied.png' }
})
const copyLocal = vi.fn(async ({ destDir }: { destDir: string }) => {
  const bytes = localFiles.get('/tmp/copied.png')
  if (!bytes) {
    throw new Error('Missing staged bytes')
  }
  const destPath = `${destDir}/copied.png`
  localFiles.set(destPath, bytes)
  return {
    results: [
      { status: 'imported', sourcePath: '/tmp/copied.png', destPath, kind: 'file', renamed: false }
    ]
  }
})

function createEditor(owner: string | null, filePath: string, content: string): Editor {
  const element = document.createElement('div')
  document.body.append(element)
  const editor = new Editor({
    element,
    extensions: [
      StarterKit,
      Image.configure({ inline: true }),
      RichMarkdownImageClipboard,
      Markdown
    ],
    content,
    contentType: 'markdown'
  })
  editors.push(editor)
  setRichMarkdownImageResolverContext(editor, {
    filePath,
    runtimeContext:
      owner === 'ssh-source'
        ? {
            target: { kind: 'local' },
            connectionId: 'source-ssh',
            expectedExternalSshTargetId: 'source-ssh',
            worktreeId: 'folder:notes',
            worktreePath: '/repo'
          }
        : owner
          ? {
              target: { kind: 'environment', environmentId: owner },
              worktreeId: 'folder:notes',
              worktreePath: '/repo'
            }
          : undefined
  })
  return editor
}
function copySource(owner: string | null = 'source'): string {
  const source = createEditor(owner, '/repo/source/note.md', 'caption ![image](image.png)')
  source.commands.selectAll()
  const html = source.view.serializeForClipboard(source.state.selection.content()).dom.innerHTML
  source.destroy()
  return html
}

function replaceOwner(owner: string): void {
  revisions.set(owner, 2)
  incarnations.set(owner, `${owner}-replacement`)
  files.set(`${owner}-replacement`, new Map())
  replaceRuntimeEnvironmentRevisions(
    [...revisions].map(([id, pairingRevision]) => ({ id, pairingRevision, createdAt: 1 })),
    { retired: [owner], sameHost: [] }
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  clearRuntimeCompatibilityCacheForTests()
  beforeRead = async () => {}
  mutationCapable = true
  files.clear()
  incarnations.clear()
  revisions.clear()
  localFiles.clear()
  sshFiles.clear()
  sshState.generation = 1
  for (const owner of ['source', 'target']) {
    incarnations.set(owner, `${owner}-original`)
    revisions.set(owner, 1)
    files.set(`${owner}-original`, new Map())
    setRuntimeEnvironmentConnectionGenerationForTests(owner, 0)
  }
  replaceRuntimeEnvironmentRevisions(
    [...revisions].map(([id, pairingRevision]) => ({ id, pairingRevision, createdAt: 1 }))
  )
  files.get('source-original')?.set('source/image.png', Buffer.from('original remote bytes'))
  localFiles.set('/repo/source/image.png', Buffer.from('original local bytes'))
  sshFiles.set('/repo/source/image.png', Buffer.from('original SSH bytes'))
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      runtimeEnvironments: { call: remoteCall },
      runtime: { call: saveLocal },
      fs: { readFile: readLocal, importExternalPaths: copyLocal }
    }
  })
})
afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy())
  document.body.replaceChildren()
})

describe.each(['paste', 'drop'] as const)('%s original-owner routing', (operation) => {
  function transferSourceSelection(
    target: Editor,
    html: string,
    owner: string | null = 'target',
    filePath = '/repo/target/note.md'
  ): void {
    const container = document.createElement('div')
    container.innerHTML = html
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/html', html)
    const slice = DOMParser.fromSchema(target.schema).parseSlice(container)
    const coordinates = vi.spyOn(target.view, 'posAtCoords').mockReturnValue({ pos: 1, inside: -1 })
    const dropEvent = new DragEvent('drop', { cancelable: true })
    Object.defineProperties(dropEvent, {
      dataTransfer: { value: clipboardData },
      clientX: { value: 50 },
      clientY: { value: 50 }
    })
    const handled =
      operation === 'paste'
        ? handleRichMarkdownPaste({
            editor: target,
            event: new ClipboardEvent('paste', { clipboardData, cancelable: true }),
            filePath,
            worktreeId: 'folder:notes',
            runtimeEnvironmentId: owner,
            slice,
            view: target.view
          })
        : handleRichMarkdownImageDrop({
            editor: target,
            view: target.view,
            event: dropEvent,
            slice,
            moved: false,
            filePath,
            worktreeId: 'folder:notes',
            runtimeEnvironmentId: owner
          })
    coordinates.mockRestore()
    expect(handled).toBe(true)
  }
  it.each([
    ['source', 'target'],
    ['source', null],
    [null, 'target'],
    ['ssh-source', 'target'],
    ['ssh-source', null]
  ])('reads from %s and imports bytes through destination %s', async (sourceOwner, targetOwner) => {
    const html = copySource(sourceOwner)
    const target = createEditor(targetOwner, '/repo/target/note.md', '')
    const done = new Promise<void>((resolve) => target.once('update', () => resolve()))
    transferSourceSelection(target, html, targetOwner)
    await done
    const expected =
      sourceOwner === 'ssh-source'
        ? 'original SSH bytes'
        : sourceOwner
          ? 'original remote bytes'
          : 'original local bytes'
    const targetBytes = targetOwner
      ? [...(files.get('target-original')?.values() ?? [])]
      : [localFiles.get('/repo/target/copied.png')]
    expect(targetBytes.map((bytes) => bytes?.toString())).toEqual([expected])
    expect(target.getMarkdown()).not.toContain('(image.png)')
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('imports even when equal directory paths belong to different runtimes', async () => {
    const html = copySource()
    const target = createEditor('target', '/repo/source/another.md', '')
    const done = new Promise<void>((resolve) => target.once('update', () => resolve()))
    transferSourceSelection(target, html, 'target', '/repo/source/another.md')
    await done
    expect(
      [...(files.get('target-original')?.values() ?? [])].map((bytes) => bytes.toString())
    ).toEqual(['original remote bytes'])
  })

  it.each(['pairing', 'connection'] as const)(
    'refuses source %s changes before any read',
    async (kind) => {
      const html = copySource()
      if (kind === 'pairing') {
        replaceOwner('source')
      } else {
        setRuntimeEnvironmentConnectionGenerationForTests('source', 1)
      }
      const target = createEditor('target', '/repo/target/note.md', 'unchanged')
      transferSourceSelection(target, html)
      expect(remoteCall).not.toHaveBeenCalled()
      expect(target.getMarkdown()).toBe('unchanged')
      expect(toast.error).toHaveBeenCalledOnce()
    }
  )

  it.each([
    ['source', 'pairing'],
    ['source', 'connection'],
    ['target', 'pairing'],
    ['target', 'connection'],
    ['target', 'close']
  ])(
    'rejects %s %s during an original source read without admitting destination writes',
    async (owner, kind) => {
      const started = Promise.withResolvers<void>()
      const held = Promise.withResolvers<void>()
      beforeRead = async () => {
        started.resolve()
        await held.promise
      }
      const html = copySource()
      const target = createEditor('target', '/repo/target/note.md', 'unchanged')
      transferSourceSelection(target, html)
      await started.promise
      if (kind === 'pairing') {
        replaceOwner(owner)
      } else if (kind === 'connection') {
        setRuntimeEnvironmentConnectionGenerationForTests(owner, 1)
      } else {
        target.destroy()
      }
      held.resolve()
      await (kind !== 'close'
        ? vi.waitFor(() => expect(toast.error).toHaveBeenCalledOnce())
        : new Promise<void>((resolve) => setImmediate(resolve)))
      expect(
        remoteCall.mock.calls
          .map(([request]) => request.method)
          .filter((method) => method !== 'status.get')
      ).toEqual(['files.readPreview'])
      expect(files.get('target-original')?.size).toBe(0)
      expect(files.get('target-replacement')?.size ?? 0).toBe(0)
      if (kind !== 'close') {
        expect(target.getMarkdown()).toBe('unchanged')
      } else {
        expect(toast.error).not.toHaveBeenCalled()
      }
    }
  )

  it('uses the existing compatibility refusal when an older destination lacks file-mutation ownership', async () => {
    mutationCapable = false
    const target = createEditor('target', '/repo/target/note.md', 'unchanged')
    transferSourceSelection(target, copySource())
    await vi.waitFor(() => expect(toast.error).toHaveBeenCalledOnce())
    expect(remoteCall.mock.calls.map(([request]) => request.method)).toEqual([
      'status.get',
      'files.readPreview',
      'status.get'
    ])
    expect(files.get('target-original')?.size).toBe(0)
    expect(target.getMarkdown()).toBe('unchanged')
  })

  it.each(['before paste', 'during read'])(
    'rejects a direct SSH source reconnect %s',
    async (phase) => {
      const started = Promise.withResolvers<void>()
      const held = Promise.withResolvers<void>()
      const html = copySource('ssh-source')
      const target = createEditor('target', '/repo/target/note.md', 'unchanged')
      if (phase === 'before paste') {
        sshState.generation = 2
      } else {
        beforeRead = async () => {
          started.resolve()
          await held.promise
        }
      }
      transferSourceSelection(target, html)
      if (phase === 'during read') {
        await started.promise
        sshState.generation = 2
        held.resolve()
      }
      await vi.waitFor(() => expect(toast.error).toHaveBeenCalledOnce())
      expect(readLocal).toHaveBeenCalledTimes(phase === 'during read' ? 1 : 0)
      expect(remoteCall).not.toHaveBeenCalled()
      expect(files.get('target-original')?.size).toBe(0)
      expect(target.getMarkdown()).toBe('unchanged')
    }
  )
})
