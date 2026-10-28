// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { setRichMarkdownImageResolverContext } from './rich-markdown-image-context'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { blobUrlCache } from './local-image-src-cache'
import { prewarmMarkdownPreviewLocalImages } from './markdown-preview-local-images'
import { resetLocalImageSrcStateForTests } from './useLocalImageSrc'

const editors: Editor[] = []
const originalApi = Object.getOwnPropertyDescriptor(window, 'api')
const readFile = vi.fn(async () => ({
  content:
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=',
  isBinary: true,
  mimeType: 'image/png'
}))
let nextUrl = 0

async function settleImages(): Promise<void> {
  for (let index = 0; index < 4_000; index += 1) {
    await Promise.resolve()
  }
}

function mountImages(count: number) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const editor = new Editor({
    element: host,
    extensions: createRichMarkdownExtensions({ codec: createRichMarkdownEditorCodec() }),
    content: Array.from({ length: count }, (_, index) => `![](image-${index}.png)`).join('\n\n'),
    contentType: 'markdown'
  })
  editors.push(editor)
  setRichMarkdownImageResolverContext(editor, { filePath: '/repo/docs/readme.md' })
  return { editor, host }
}

beforeEach(() => {
  resetLocalImageSrcStateForTests()
  readFile.mockClear()
  nextUrl = 0
  Object.defineProperty(window, 'api', { value: { fs: { readFile } }, configurable: true })
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:capacity-${nextUrl++}`)
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
})

afterEach(() => {
  for (const editor of editors.splice(0)) {
    if (!editor.isDestroyed) {
      editor.destroy()
    }
  }
  resetLocalImageSrcStateForTests()
  vi.restoreAllMocks()
  if (originalApi) {
    Object.defineProperty(window, 'api', originalApi)
  } else {
    Reflect.deleteProperty(window, 'api')
  }
  document.body.innerHTML = ''
})

it.each([101, 1_000])(
  'displays every image in a %i-image document within the byte budget',
  async (count) => {
    const view = mountImages(count)
    await settleImages()
    const images = Array.from(view.host.querySelectorAll('img'))
    const loaded = images.filter((image) => image.hasAttribute('src')).length
    console.info(
      'PINNED_IMAGE_CAPACITY',
      JSON.stringify({ population: count, loadedImages: loaded })
    )
    expect(images).toHaveLength(count)
    expect(readFile).toHaveBeenCalledTimes(count)
    expect(loaded).toBe(count)
    expect(blobUrlCache.size).toBe(count)
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    const prewarm = prewarmMarkdownPreviewLocalImages('![](unleased.png)', '/repo/docs/readme.md')
    await prewarm.done
    expect(blobUrlCache.size).toBe(count)
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1)
    view.editor.destroy()
    expect(blobUrlCache.size).toBe(100)
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(count - 100 + 1)
  }
)

it('preserves a shared displayed URL while closing the larger owner prunes unleased entries', async () => {
  const first = mountImages(101)
  const second = mountImages(1)
  await settleImages()
  const shared = second.host.querySelector('img')?.src
  expect(shared).toBe(first.host.querySelector('img')?.src)
  expect(readFile).toHaveBeenCalledTimes(101)
  first.editor.destroy()
  expect(blobUrlCache.size).toBe(100)
  expect(second.host.querySelector('img')?.src).toBe(shared)
  expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(shared)
  const prewarm = prewarmMarkdownPreviewLocalImages('![](successor.png)', '/repo/docs/readme.md')
  await prewarm.done
  expect(blobUrlCache.size).toBe(100)
  expect(second.host.querySelector('img')?.src).toBe(shared)
  expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(shared)
})

it('keeps an entirely unleased prewarm within the entry target', async () => {
  const prewarm = prewarmMarkdownPreviewLocalImages(
    Array.from({ length: 101 }, (_, index) => `![](prewarm-${index}.png)`).join('\n\n'),
    '/repo/docs/readme.md',
    { limit: 101 }
  )
  await prewarm.done
  expect(readFile).toHaveBeenCalledTimes(101)
  expect(blobUrlCache.size).toBe(100)
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1)
})
