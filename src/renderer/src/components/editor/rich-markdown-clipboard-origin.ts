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
import {
  isRelativeClipboardLink,
  rebaseClipboardLink,
  resolveRelativeClipboardLink
} from './rich-markdown-clipboard-link-target'

const ORIGIN_ATTRIBUTE = 'data-orca-image-clipboard-origin'
const LINK_ORIGIN_ATTRIBUTE = 'data-orca-link-clipboard-origin'
const MAX_ORIGINS = 16
const MAX_SOURCE_CHARACTERS = 32 * 1024
const MAX_REFERENCES_PER_KIND = 256

type ClipboardSource = {
  filePath: string
  runtimeContext?: RichMarkdownImageRuntimeContext
  access: ReturnType<typeof documentResourceAccess>
  assertCurrent?: () => void
}

export type RichMarkdownClipboardImageSource = ClipboardSource & { absolutePath: string }
type ClipboardLinkSource = ClipboardSource & { absoluteHref: string }
type ClipboardOrigin = {
  images: Map<string, RichMarkdownClipboardImageSource>
  links: Map<string, ClipboardLinkSource>
}

const origins = new Map<string, ClipboardOrigin>()

export function sameRichMarkdownClipboardFileOwner(
  source: RichMarkdownImageRuntimeContext | undefined,
  destination: Pick<
    RichMarkdownImageRuntimeContext,
    'target' | 'connectionId' | 'expectedExternalSshTargetId'
  >
): boolean {
  return (
    (source?.target.kind ?? 'local') === destination.target.kind &&
    (source?.target.kind !== 'environment' ||
      (destination.target.kind === 'environment' &&
        source.target.environmentId === destination.target.environmentId)) &&
    (source?.connectionId ?? null) === (destination.connectionId ?? null) &&
    source?.expectedExternalSshTargetId === destination.expectedExternalSshTargetId
  )
}

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

function captureSource(editor: Editor): ClipboardSource | null {
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
    const source = id && src ? origins.get(id)?.images.get(src) : undefined
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

function rebaseClipboardLinks(html: string, editor: Editor): string {
  if (!html.includes(LINK_ORIGIN_ATTRIBUTE)) {
    return html
  }
  const destination = captureSource(editor)
  if (!destination) {
    return html
  }
  const document = new DOMParser().parseFromString(html, 'text/html')
  let changed = false
  for (const link of document.querySelectorAll(`a[${LINK_ORIGIN_ATTRIBUTE}]`)) {
    const id = link.getAttribute(LINK_ORIGIN_ATTRIBUTE)
    const href = link.getAttribute('href')
    const source = id && href ? origins.get(id)?.links.get(href) : undefined
    if (
      !source ||
      !href ||
      !sameRichMarkdownClipboardFileOwner(
        source.runtimeContext,
        destination.runtimeContext ?? { target: { kind: 'local' } }
      )
    ) {
      continue
    }
    try {
      source.assertCurrent?.()
      const rebased = rebaseClipboardLink(href, source.absoluteHref, destination.filePath)
      if (rebased !== href) {
        link.setAttribute('href', rebased)
        changed = true
      }
    } catch {
      continue
    }
  }
  return changed ? document.body.innerHTML : html
}

export const RichMarkdownClipboardOrigin = Extension.create({
  name: 'richMarkdownClipboardOrigin',
  addProseMirrorPlugins() {
    const editor = this.editor
    const serializer = DOMSerializer.fromSchema(editor.schema)
    const serializeImage = serializer.nodes.image
    const serializeLink = serializer.marks.link
    let origin: string | null = null
    let source: ClipboardSource | null | undefined
    let characters = 0
    let valid = true
    const getSource = (): ClipboardSource | null => {
      if (source === undefined) {
        source = captureSource(editor)
        characters = source?.filePath.length ?? 0
      }
      return source
    }
    const captureOrigin = (
      kind: 'images' | 'links',
      key: string,
      resolved: string
    ): string | null => {
      const owner = getSource()
      if (!valid || !owner) {
        return null
      }
      if (!origin) {
        origin = createBrowserUuid()
        origins.set(origin, { images: new Map(), links: new Map() })
        if (origins.size > MAX_ORIGINS) {
          const oldest = origins.keys().next().value
          if (oldest !== undefined) {
            origins.delete(oldest)
          }
        }
      }
      const entry = origins.get(origin)
      if (!entry) {
        return null
      }
      if (!entry[kind].has(key)) {
        characters += key.length + resolved.length
        if (characters > MAX_SOURCE_CHARACTERS || entry[kind].size >= MAX_REFERENCES_PER_KIND) {
          origins.delete(origin)
          valid = false
          return null
        }
        if (kind === 'images') {
          entry.images.set(key, { ...owner, absolutePath: resolved })
        } else {
          entry.links.set(key, { ...owner, absoluteHref: resolved })
        }
      }
      return origin
    }
    return [
      new Plugin({
        props: {
          transformPastedHTML: (html) => rebaseClipboardLinks(html, editor),
          transformCopied: (slice) => {
            origin = null
            source = undefined
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
                const owner = getSource()
                const absolutePath = owner
                  ? resolveImageAbsolutePath(node.attrs.src, owner.filePath)
                  : null
                if (!absolutePath) {
                  return result.dom
                }
                const id = captureOrigin('images', node.attrs.src, absolutePath)
                if (id) {
                  result.dom.setAttribute(ORIGIN_ATTRIBUTE, id)
                }
                return result.dom
              }
            },
            {
              ...serializer.marks,
              ...(serializeLink
                ? {
                    link: (mark, inline) => {
                      const result = DOMSerializer.renderSpec(document, serializeLink(mark, inline))
                      if (
                        valid &&
                        typeof mark.attrs.href === 'string' &&
                        isRelativeClipboardLink(mark.attrs.href) &&
                        result.dom instanceof HTMLElement
                      ) {
                        const owner = getSource()
                        const absoluteHref = owner
                          ? resolveRelativeClipboardLink(mark.attrs.href, owner.filePath)
                          : null
                        const id = absoluteHref
                          ? captureOrigin('links', mark.attrs.href, absoluteHref)
                          : null
                        if (id) {
                          result.dom.setAttribute(LINK_ORIGIN_ATTRIBUTE, id)
                        }
                      }
                      return result
                    }
                  }
                : {})
            }
          )
        }
      })
    ]
  }
})
