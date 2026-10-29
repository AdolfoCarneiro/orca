import { useAppStore } from '@/store'
import { detectLanguage } from '@/lib/language-detect'
import { buildMarkdownExportHtml } from './markdown-export-html'
import {
  captureMarkdownExportLocalImages,
  inlineMarkdownExportLocalImages
} from './markdown-export-local-images'

export type MarkdownExportPayload = {
  title: string
  html: string
}

// Select only document DOM, excluding preview search and rich-editor toolbars, menus and bubbles.
const DOCUMENT_SUBTREE_SELECTOR = '.ProseMirror, .markdown-body'

// Remove in-document controls and transient highlights from the cloned export subtree.
const UI_ONLY_SELECTORS = [
  '.code-block-copy-btn',
  '.markdown-preview-search',
  '[class*="rich-markdown-search"]',
  // Keep the explicit class fallback if export-hide attributes are stripped.
  '.markdown-annotation-controls',
  '[data-orca-export-hide]'
]

function basenameWithoutExt(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() ?? filePath
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}

function findDocumentSubtree(root: ParentNode): Element | null {
  return root.querySelector(DOCUMENT_SUBTREE_SELECTOR)
}

/** Clone the panel’s rendered document without UI; return null for stale files or source-only views. */
export function getActiveMarkdownExportPayload(options: {
  fileId: string
  root: ParentNode | null
}): Promise<MarkdownExportPayload | null> {
  try {
    return prepareMarkdownExportPayload(options)
  } catch (error) {
    return Promise.reject(error)
  }
}

function prepareMarkdownExportPayload({
  fileId,
  root
}: {
  fileId: string
  root: ParentNode | null
}): Promise<MarkdownExportPayload | null> {
  if (!root) {
    return Promise.resolve(null)
  }
  const state = useAppStore.getState()
  const activeFile = state.openFiles.find((f) => f.id === fileId)
  if (!activeFile || (activeFile.mode !== 'edit' && activeFile.mode !== 'markdown-preview')) {
    return Promise.resolve(null)
  }
  const language = detectLanguage(activeFile.filePath)
  if (language !== 'markdown') {
    return Promise.resolve(null)
  }

  const subtree = findDocumentSubtree(root)
  if (!subtree || subtree.hasAttribute('data-markdown-preview-incomplete')) {
    return Promise.resolve(null)
  }

  const clone = subtree.cloneNode(true) as Element
  const localImages = captureMarkdownExportLocalImages(subtree, clone, UI_ONLY_SELECTORS.join(','))
  for (const image of clone.querySelectorAll('img')) {
    image.loading = 'eager'
  }
  for (const selector of UI_ONLY_SELECTORS) {
    for (const node of clone.querySelectorAll(selector)) {
      node.remove()
    }
  }
  const title = basenameWithoutExt(activeFile.relativePath || activeFile.filePath)
  return buildMarkdownExportPayload(clone, title, localImages)
}

async function buildMarkdownExportPayload(
  clone: Element,
  title: string,
  localImages: ReturnType<typeof captureMarkdownExportLocalImages>
): Promise<MarkdownExportPayload | null> {
  const controller = new AbortController()
  try {
    await Promise.all([
      inlineBlobImageSources(clone, controller),
      inlineMarkdownExportLocalImages(localImages, controller)
    ])
  } catch (error) {
    controller.abort(error)
    throw error
  }

  const renderedHtml = clone.innerHTML.trim()
  if (!renderedHtml) {
    return null
  }

  const html = buildMarkdownExportHtml({ title, renderedHtml })
  return { title, html }
}

function inlineBlobImageSources(root: Element, controller: AbortController): Promise<void> {
  const { signal } = controller
  const images = Array.from(root.querySelectorAll<HTMLImageElement>('img[src^="blob:"]'))
  const sources = images.map((image) => image.getAttribute('src'))
  const clearImages = (): void => {
    images.length = 0
  }
  signal.addEventListener('abort', clearImages, { once: true })
  return Promise.all(
    sources.map((src) => (src ? readBlobImageAsDataUrl(src, signal) : Promise.resolve(null)))
  )
    .then((dataUrls) => {
      signal.throwIfAborted()
      for (const [index, image] of images.entries()) {
        const dataUrl = dataUrls[index]
        if (dataUrl) {
          image.setAttribute('src', dataUrl)
        }
      }
    })
    .finally(() => signal.removeEventListener('abort', clearImages))
}

async function readBlobImageAsDataUrl(src: string, signal: AbortSignal): Promise<string> {
  try {
    signal.throwIfAborted()
    const response = await fetch(src, { signal })
    signal.throwIfAborted()
    if (!response.ok) {
      throw new Error('Unable to fetch blob image')
    }
    const blob = await response.blob()
    signal.throwIfAborted()
    const bytes = new Uint8Array(await blob.arrayBuffer())
    signal.throwIfAborted()
    return `data:${blob.type || 'application/octet-stream'};base64,${bytesToBase64(bytes)}`
  } catch (error) {
    signal.throwIfAborted()
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to inline image for PDF export: ${message}`)
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize))
  }
  return btoa(binary)
}
