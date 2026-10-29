import { Extension, type Editor } from '@tiptap/core'
import { DOMSerializer } from '@tiptap/pm/model'
import { Plugin } from '@tiptap/pm/state'
import { isWindowsAbsolutePathLike } from '../../../../shared/cross-platform-path'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { captureDirectSshMutationExpectation } from '@/lib/ssh-mutation-expectation'
import { useAppStore } from '@/store'
import { captureRuntimeEnvironmentRequestRevision } from '@/runtime/runtime-environment-revision'
import { getRuntimeEnvironmentConnectionGeneration } from '@/store/slices/runtime-status'
import { createRuntimeImportSessionGuard } from '@/runtime/runtime-file-mutation-rpc'
import { documentResourceAccess } from '@/lib/local-file-access'
import { readRichMarkdownImageRuntimeContext } from './rich-markdown-image-context'
import type { RichMarkdownImageRuntimeContext } from './rich-markdown-image-context'
import { resolveImageAbsolutePath } from './markdown-preview-links'

const ORIGIN_ATTRIBUTE = 'data-orca-image-clipboard-origin'
const MAX_ORIGINS = 16
const MAX_SOURCE_CHARACTERS = 32 * 1024
const MAX_IMAGES = 256

export type RichMarkdownClipboardImageSource = {
  absolutePath: string
  filePath: string
  runtimeContext?: RichMarkdownImageRuntimeContext
  access: ReturnType<typeof documentResourceAccess>
  assertCurrent?: () => void
}

const origins = new Map<string, Map<string, RichMarkdownClipboardImageSource>>()

function captureSourceGuard(
  context: RichMarkdownImageRuntimeContext | undefined
): (() => void) | undefined {
  if (context?.target.kind === 'environment') {
    return createRuntimeImportSessionGuard(
      context.target.environmentId,
      captureRuntimeEnvironmentRequestRevision(context.target.environmentId),
      getRuntimeEnvironmentConnectionGeneration(context.target.environmentId)
    )
  }
  const connectionId = context?.connectionId
  if (!connectionId) {
    return undefined
  }
  const expected = captureDirectSshMutationExpectation(useAppStore.getState(), connectionId)
  return () => {
    const current = captureDirectSshMutationExpectation(useAppStore.getState(), connectionId)
    if (current.expectedSshConnectionGeneration !== expected.expectedSshConnectionGeneration) {
      throw new Error('Source image connection changed; copy the selection again.')
    }
  }
}

function captureSource(
  editor: Editor
): Omit<RichMarkdownClipboardImageSource, 'absolutePath'> | null {
  const storage: unknown = 'image' in editor.storage ? editor.storage.image : undefined
  if (
    !storage ||
    typeof storage !== 'object' ||
    !('filePath' in storage) ||
    typeof storage.filePath !== 'string' ||
    !storage.filePath
  ) {
    return null
  }
  const context = readRichMarkdownImageRuntimeContext({
    runtimeContext: 'runtimeContext' in storage ? storage.runtimeContext : undefined
  })
  if (context === null) {
    return null
  }
  const runtimeContext = context ? { ...context, target: { ...context.target } } : undefined
  const filePath = storage.filePath
  let assertCurrent: (() => void) | undefined
  try {
    assertCurrent = captureSourceGuard(runtimeContext)
  } catch {
    return null
  }
  return { filePath, runtimeContext, access: documentResourceAccess(filePath), assertCurrent }
}

export function readRichMarkdownClipboardImageSources(
  html: string
): Map<string, RichMarkdownClipboardImageSource> {
  const sources = new Map<string, RichMarkdownClipboardImageSource>()
  if (!html.includes(ORIGIN_ATTRIBUTE)) {
    return sources
  }
  const document = new DOMParser().parseFromString(html, 'text/html')
  const conflictingSources = new Set<string>()
  for (const image of document.querySelectorAll(`img[${ORIGIN_ATTRIBUTE}]`)) {
    const id = image.getAttribute(ORIGIN_ATTRIBUTE)
    const src = image.getAttribute('src')
    const source = id && src ? origins.get(id)?.get(src) : undefined
    if (source && src && !conflictingSources.has(src)) {
      const existing = sources.get(src)
      if (existing && existing !== source) {
        sources.delete(src)
        conflictingSources.add(src)
      } else {
        sources.set(src, source)
      }
    }
  }
  return sources
}

export const RichMarkdownImageClipboard = Extension.create({
  name: 'richMarkdownImageClipboard',
  addProseMirrorPlugins() {
    const editor = this.editor
    const serializer = DOMSerializer.fromSchema(editor.schema)
    const serializeImage = serializer.nodes.image
    let origin: string | null = null
    let source: Omit<RichMarkdownClipboardImageSource, 'absolutePath'> | null = null
    let sourceCaptured = false
    let characters = 0
    let valid = true
    return [
      new Plugin({
        props: {
          transformCopied: (slice) => {
            origin = null
            source = null
            sourceCaptured = false
            characters = 0
            valid = true
            return slice
          },
          clipboardSerializer: new DOMSerializer(
            {
              ...serializer.nodes,
              image: (node) => {
                const result = DOMSerializer.renderSpec(document, serializeImage(node))
                if (
                  !valid ||
                  typeof node.attrs.src !== 'string' ||
                  !(result.dom instanceof HTMLElement)
                ) {
                  return result.dom
                }
                const rawSrc = node.attrs.src.trimStart()
                if (
                  /^[a-z][a-z\d+.-]*:/i.test(rawSrc) &&
                  !/^file:/i.test(rawSrc) &&
                  !isWindowsAbsolutePathLike(rawSrc)
                ) {
                  return result.dom
                }
                if (!sourceCaptured) {
                  sourceCaptured = true
                  source = captureSource(editor)
                  characters = source?.filePath.length ?? 0
                }
                const absolutePath = source
                  ? resolveImageAbsolutePath(node.attrs.src, source.filePath)
                  : null
                if (!source || !absolutePath) {
                  return result.dom
                }
                if (!origin) {
                  origin = createBrowserUuid()
                  origins.set(origin, new Map())
                  if (origins.size > MAX_ORIGINS) {
                    const oldest = origins.keys().next().value
                    if (oldest !== undefined) {
                      origins.delete(oldest)
                    }
                  }
                }
                const sources = origins.get(origin)
                if (!sources) {
                  return result.dom
                }
                if (!sources.has(node.attrs.src)) {
                  characters += node.attrs.src.length + absolutePath.length
                  if (characters > MAX_SOURCE_CHARACTERS || sources.size >= MAX_IMAGES) {
                    origins.delete(origin)
                    valid = false
                    return result.dom
                  }
                  sources.set(node.attrs.src, { ...source, absolutePath })
                }
                result.dom.setAttribute(ORIGIN_ATTRIBUTE, origin)
                return result.dom
              }
            },
            serializer.marks
          )
        }
      })
    ]
  }
})
