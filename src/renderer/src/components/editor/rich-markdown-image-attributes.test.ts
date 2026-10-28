// @vitest-environment happy-dom
import { Editor, Extension } from '@tiptap/core'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { setRichMarkdownImageResolverContext } from './rich-markdown-image-context'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { resetLocalImageSrcStateForTests } from './useLocalImageSrc'

type FileResult = Awaited<ReturnType<Window['api']['fs']['readFile']>>
const imageResult: FileResult = { content: 'AA==', isBinary: true, mimeType: 'image/png' }
const readFile = vi.fn<Window['api']['fs']['readFile']>()
const originalApi = Object.getOwnPropertyDescriptor(window, 'api')
const editors: Editor[] = []

async function settleImages(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function mountImage() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const editor = new Editor({
    element: host,
    extensions: [
      ...createRichMarkdownExtensions({ codec: createRichMarkdownEditorCodec() }),
      Extension.create({
        name: 'imageCaption',
        addGlobalAttributes() {
          return [
            {
              types: ['image'],
              attributes: {
                caption: {
                  default: null,
                  renderHTML: (attrs) => ({ 'data-caption': attrs.caption })
                }
              }
            }
          ]
        }
      })
    ],
    content: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'image',
              attrs: {
                src: 'before.png',
                alt: 'Before',
                title: 'Old title',
                width: 80,
                height: 40,
                caption: 'Old caption'
              }
            }
          ]
        }
      ]
    }
  })
  editors.push(editor)
  setRichMarkdownImageResolverContext(editor, { filePath: '/repo/docs/readme.md' })
  const image = host.querySelector('img')
  if (!image) {
    throw new Error('Image did not mount')
  }
  return { editor, image }
}

function updateImage(editor: Editor, attributes: Record<string, unknown>): void {
  const node = editor.state.doc.nodeAt(1)
  if (!node) {
    throw new Error('Image node missing')
  }
  editor.view.dispatch(
    editor.state.tr.setNodeMarkup(1, undefined, { ...node.attrs, ...attributes })
  )
}

beforeEach(() => {
  resetLocalImageSrcStateForTests()
  readFile.mockReset().mockResolvedValue(imageResult)
  Object.defineProperty(window, 'api', { configurable: true, value: { fs: { readFile } } })
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:attributes')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
})

afterEach(() => {
  for (const editor of editors.splice(0)) {
    editor.destroy()
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

it('updates rendered image metadata without replacing or reloading its display', async () => {
  const { editor, image } = mountImage()
  await settleImages()
  expect(image.getAttribute('src')).toBe('blob:attributes')
  updateImage(editor, {
    alt: 'After',
    title: 'New title',
    width: 160,
    height: 90,
    caption: 'New caption'
  })
  expect(editor.view.dom.querySelector('img')).toBe(image)
  expect(image.alt).toBe('After')
  expect(image.title).toBe('New title')
  expect(image.width).toBe(160)
  expect(image.height).toBe(90)
  expect(image.getAttribute('data-caption')).toBe('New caption')
  expect(image.draggable).toBe(false)
  await settleImages()
  expect(readFile).toHaveBeenCalledTimes(1)
  expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
  expect(URL.revokeObjectURL).not.toHaveBeenCalled()
})

it('removes cleared metadata and preserves undo and redo on the same image', async () => {
  const { editor, image } = mountImage()
  await settleImages()
  updateImage(editor, { alt: null, title: null, width: null, height: null, caption: null })
  for (const name of ['alt', 'title', 'width', 'height', 'data-caption']) {
    expect(image.hasAttribute(name), name).toBe(false)
  }
  expect(editor.commands.undo()).toBe(true)
  expect(image.alt).toBe('Before')
  expect(image.title).toBe('Old title')
  expect(image.width).toBe(80)
  expect(editor.commands.redo()).toBe(true)
  expect(image.hasAttribute('title')).toBe(false)
  expect(image.getAttribute('src')).toBe('blob:attributes')
  expect(readFile).toHaveBeenCalledTimes(1)
})

it('updates metadata while rejecting a late read for the previous source', async () => {
  const oldRead = Promise.withResolvers<FileResult>()
  readFile.mockReturnValueOnce(oldRead.promise)
  vi.mocked(URL.createObjectURL)
    .mockReturnValueOnce('blob:attributes')
    .mockReturnValue('blob:late-read')
  const { editor, image } = mountImage()
  await settleImages()
  expect(readFile).toHaveBeenCalledTimes(1)
  updateImage(editor, { src: 'after.png', alt: 'After', title: 'New title' })
  await settleImages()
  expect(image.alt).toBe('After')
  expect(image.title).toBe('New title')
  expect(image.getAttribute('src')).toBe('blob:attributes')
  oldRead.resolve(imageResult)
  await settleImages()
  expect(image.getAttribute('src')).toBe('blob:attributes')
  expect(image.alt).toBe('After')
  expect(readFile).toHaveBeenCalledTimes(2)
})
