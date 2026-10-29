// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { getActiveMarkdownExportPayload } from './markdown-export-extract'
import { setDocumentImageSource } from './document-image-sources'
import { readLocalImagePreview } from './local-image-src-reader'

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      openFiles: [{ id: 'document', filePath: '/repo/readme.md', mode: 'edit' }]
    })
  }
}))
vi.mock('./local-image-src-reader', () => ({ readLocalImagePreview: vi.fn() }))

function documentWithBlobs(className = 'ProseMirror') {
  const root = document.createElement('section')
  const source = document.createElement('div')
  source.className = className
  source.textContent = `Exported content ${'x'.repeat(1024 * 1024)}`
  for (const src of ['blob:missing', 'blob:pending']) {
    const image = document.createElement('img')
    image.src = src
    source.append(image)
  }
  root.append(source)
  return { root, source }
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

async function collect(): Promise<void> {
  if (typeof globalThis.gc !== 'function') {
    throw new Error('The test runner must enable --expose-gc')
  }
  for (let round = 0; round < 3; round += 1) {
    await settle()
    globalThis.gc()
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it.each(['ProseMirror', 'markdown-body'])(
  'releases a failed %s clone while a noncooperative blob read remains pending',
  async (className) => {
    const failure = Promise.withResolvers<Response>()
    const body = Promise.withResolvers<Blob>()
    const response = new Response()
    vi.spyOn(response, 'blob').mockReturnValue(body.promise)
    const signals: (AbortSignal | null | undefined)[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn((src: string, init?: RequestInit) => {
        signals.push(init?.signal)
        return src === 'blob:missing' ? failure.promise : Promise.resolve(response)
      })
    )
    const { root, source } = documentWithBlobs(className)
    const cloneNode = source.cloneNode.bind(source)
    let clone: WeakRef<Node> | undefined
    const cloneSource = vi.spyOn(source, 'cloneNode').mockImplementation((deep) => {
      const node = cloneNode(deep)
      clone = new WeakRef(node)
      return node
    })
    const payload = getActiveMarkdownExportPayload({ fileId: 'document', root })
    cloneSource.mockClear()
    const rejected = expect(payload).rejects.toThrow('broken source')
    try {
      await settle()
      expect(signals).toHaveLength(2)
      failure.reject(new Error('broken source'))
      await rejected
      await collect()
      expect(clone).toBeDefined()
      expect(clone?.deref()).toBeUndefined()
      expect(signals.every((signal) => signal?.aborted)).toBe(true)
      expect(source.querySelectorAll('img[src^="blob:"]')).toHaveLength(2)
    } finally {
      body.resolve(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }))
      await payload.catch(() => undefined)
      await settle()
    }
  }
)

it('skips base64 construction when an already-started byte read finishes after failure', async () => {
  const failure = Promise.withResolvers<Response>()
  const bytes = Promise.withResolvers<ArrayBuffer>()
  const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })
  const readBytes = vi.spyOn(blob, 'arrayBuffer').mockReturnValue(bytes.promise)
  const response = new Response()
  vi.spyOn(response, 'blob').mockResolvedValue(blob)
  const encode = vi.spyOn(globalThis, 'btoa')
  vi.stubGlobal(
    'fetch',
    vi.fn((src: string) => (src === 'blob:missing' ? failure.promise : Promise.resolve(response)))
  )
  const { root } = documentWithBlobs()
  const payload = getActiveMarkdownExportPayload({ fileId: 'document', root })
  const rejected = expect(payload).rejects.toThrow('broken source')
  try {
    await settle()
    expect(readBytes).toHaveBeenCalledOnce()
    failure.reject(new Error('broken source'))
    await rejected
    bytes.resolve(new Uint8Array([1, 2, 3]).buffer)
    await settle()
    expect(encode).not.toHaveBeenCalled()
  } finally {
    bytes.resolve(new ArrayBuffer(0))
    await payload.catch(() => undefined)
    await settle()
  }
})

it('cancels blob peers with the original local-image failure', async () => {
  const failure = new Error('local image unavailable')
  const local = Promise.withResolvers<Awaited<ReturnType<typeof readLocalImagePreview>>>()
  vi.mocked(readLocalImagePreview).mockReturnValue(local.promise)
  const body = Promise.withResolvers<Blob>()
  const response = new Response()
  vi.spyOn(response, 'blob').mockReturnValue(body.promise)
  const signals: (AbortSignal | null | undefined)[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((_src: string, init?: RequestInit) => {
      signals.push(init?.signal)
      return Promise.resolve(response)
    })
  )
  const { root, source } = documentWithBlobs()
  const image = source.querySelector('img')
  if (!image) {
    throw new Error('Missing local-image fixture')
  }
  setDocumentImageSource(image, { src: './image.png', filePath: '/repo/readme.md' })
  const payload = getActiveMarkdownExportPayload({ fileId: 'document', root })
  const rejected = expect(payload).rejects.toBe(failure)
  try {
    await settle()
    expect(signals).toHaveLength(1)
    local.reject(failure)
    await rejected
    expect(signals[0]?.aborted).toBe(true)
    expect(signals[0]?.reason).toBe(failure)
  } finally {
    body.resolve(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }))
    await payload.catch(() => undefined)
    await settle()
  }
})
