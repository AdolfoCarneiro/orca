import { Fragment, Slice, type Node as ProseMirrorNode } from '@tiptap/pm/model'
import { TextSelection, type Transaction } from '@tiptap/pm/state'
import { handlePaste as handleTablePaste } from '@tiptap/pm/tables'
import { closeHistory } from '@tiptap/pm/history'
import { toast } from 'sonner'
import { decodeBase64Bytes } from '@/lib/base64-bytes'
import { assertClipboardImageBase64LengthWithinLimit } from '../../../../shared/clipboard-image'
import { readLocalImagePreview } from './local-image-src-reader'
import {
  readRichMarkdownClipboardImageSources,
  type RichMarkdownClipboardImageSource
} from './rich-markdown-image-clipboard'
import { basename, dirname } from '@/lib/path'
import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client-types'
import { blobToBase64, convertImageBlobToPng } from '@/lib/image-blob-png'
import { importRuntimeImage } from '@/runtime/runtime-image-import-client'
import { createRuntimeImportSessionGuard } from '@/runtime/runtime-file-mutation-rpc'
import { captureRuntimeEnvironmentRequestRevision } from '@/runtime/runtime-environment-revision'
import { getRuntimeEnvironmentConnectionGeneration } from '@/store/slices/runtime-status'
import { waitForPromiseWithSignal } from '../../../../shared/abort-signal-reason'
import type { RichMarkdownImagePasteArgs } from './rich-markdown-paste-image'
import { captureRichMarkdownImageImportContext } from './rich-markdown-image-insert'
import { captureRichMarkdownImageInsertionTarget } from './rich-markdown-image-insertion-target'
import { richMarkdownClipboardInsertionOrderKey } from './rich-markdown-clipboard-insertion-order'
import { extractIpcErrorMessage } from './rich-markdown-ipc-error-message'
import { inspectRichMarkdownSourceOwningSlice } from './rich-markdown-source-owning-slice'
import { showRichMarkdownImageInsertionProgress } from './rich-markdown-image-insertion-feedback'

export function handleRichMarkdownHtmlImagePaste({
  editor,
  event,
  filePath,
  worktreeId,
  runtimeEnvironmentId,
  slice
}: RichMarkdownImagePasteArgs): boolean {
  const html = event.clipboardData?.getData('text/html') ?? ''
  if (
    !editor ||
    !slice ||
    (!html.includes('blob:') && !html.includes('data-orca-image-clipboard-origin')) ||
    !inspectRichMarkdownSourceOwningSlice(slice).canPreserve
  ) {
    return false
  }
  const localSources = readRichMarkdownClipboardImageSources(html)
  const sources = new Set<string>()
  slice.content.descendants((node) => {
    if (
      node.type.name === 'image' &&
      typeof node.attrs.src === 'string' &&
      (node.attrs.src.startsWith('blob:') || localSources.has(node.attrs.src))
    ) {
      sources.add(node.attrs.src)
    }
  })
  if (!sources.size) {
    return false
  }
  const target = captureRichMarkdownImageInsertionTarget(editor, {
    includeSingleCellSelection: true
  })
  if (!target) {
    event.preventDefault()
    return true
  }
  const { signal } = target
  const pending: { slice: Slice | null } = { slice }
  signal.addEventListener(
    'abort',
    () => {
      pending.slice = null
    },
    { once: true }
  )
  const assertTargetCurrent = (): void => {
    signal.throwIfAborted()
    if (!target.getRange()) {
      target.dispose()
      signal.throwIfAborted()
    }
  }
  try {
    const destination = captureRichMarkdownImageImportContext({
      filePath,
      worktreeId,
      runtimeEnvironmentId
    })
    if (!destination) {
      event.preventDefault()
      target.dispose()
      return true
    }
    for (const [src, source] of localSources) {
      if (!sources.has(src)) {
        localSources.delete(src)
        continue
      }
      source.assertCurrent?.()
      if (
        sameImageFileOwner(source.runtimeContext, destination.context) &&
        normalizeRuntimePathForComparison(dirname(source.filePath)) ===
          normalizeRuntimePathForComparison(dirname(filePath))
      ) {
        sources.delete(src)
        localSources.delete(src)
      }
    }
    if (!sources.size) {
      target.dispose()
      return false
    }
    event.preventDefault()
    const runtimeTarget = destination.context.target
    const assertCurrent =
      runtimeTarget.kind === 'environment'
        ? createRuntimeImportSessionGuard(
            runtimeTarget.environmentId,
            captureRuntimeEnvironmentRequestRevision(runtimeTarget.environmentId),
            getRuntimeEnvironmentConnectionGeneration(runtimeTarget.environmentId),
            assertTargetCurrent
          )
        : assertTargetCurrent
    showRichMarkdownImageInsertionProgress(signal)
    // Accepted fetches must start before source owners can revoke their object URLs.
    const responses = Promise.all(
      [...sources].map((src) =>
        localSources.has(src) ? Promise.resolve(null) : fetch(src, { signal })
      )
    )
    void importHtmlImages(responses, [...sources], localSources, destination, {
      assertCurrent,
      signal
    })
      .then((replacements) => {
        assertCurrent()
        const sourceSlice = pending.slice
        const range = target.getRange()
        const owner = target.getEditor()
        if (!sourceSlice || !range || !owner) {
          return
        }
        const importedSlice = new Slice(
          replaceImportedImages(sourceSlice.content, replacements),
          sourceSlice.openStart,
          sourceSlice.openEnd
        )
        pending.slice = null
        const liveSelection = owner.state.selection
        const selectionStillAtTarget = range.cellSelection
          ? liveSelection.eq(range.cellSelection)
          : liveSelection.from === range.from && liveSelection.to === range.to
        const pasteSelection =
          range.cellSelection ??
          TextSelection.between(
            owner.state.doc.resolve(range.from),
            owner.state.doc.resolve(range.to)
          )
        const state = owner.state.apply(
          owner.state.tr.setSelection(pasteSelection).setMeta('addToHistory', false)
        )
        const dispatch = (tr: Transaction): void => {
          closeHistory(tr)
          if (selectionStillAtTarget) {
            tr.scrollIntoView()
          } else {
            tr.setSelection(liveSelection.map(tr.doc, tr.mapping))
          }
          owner.view.dispatch(
            tr
              .setMeta('paste', true)
              .setMeta('uiEvent', 'paste')
              .setMeta(richMarkdownClipboardInsertionOrderKey, range.requestOrder)
          )
        }
        // Native table paste needs the mapped selection while the user's live caret can move.
        const view = new Proxy(owner.view, {
          get(original, property, receiver) {
            if (property === 'state') {
              return state
            }
            if (property === 'dispatch') {
              return dispatch
            }
            // oxlint-disable-next-line anti-slop/no-reflect-get -- Proxy get trap forwards native view members.
            return Reflect.get(original, property, receiver)
          }
        })
        if (!handleTablePaste(view, new ClipboardEvent('paste'), importedSlice)) {
          dispatch(state.tr.replaceSelection(importedSlice))
        }
      })
      .catch((error) => {
        if (!signal.aborted) {
          toast.error(extractIpcErrorMessage(error, 'Failed to insert image.'))
        }
      })
      .finally(target.dispose)
  } catch (error) {
    event.preventDefault()
    target.dispose()
    toast.error(extractIpcErrorMessage(error, 'Failed to insert image.'))
  }
  return true
}

async function importHtmlImages(
  responsesPromise: Promise<(Response | null)[]>,
  sources: string[],
  localSources: Map<string, RichMarkdownClipboardImageSource>,
  destination: NonNullable<ReturnType<typeof captureRichMarkdownImageImportContext>>,
  options: { assertCurrent: () => void; signal: AbortSignal }
): Promise<Map<string, string>> {
  const responses: (Response | null)[] = await waitForPromiseWithSignal(
    responsesPromise,
    options.signal
  )
  const replacements = new Map<string, string>()
  try {
    for (const [index, src] of sources.entries()) {
      options.assertCurrent()
      const response = responses[index]
      responses[index] = null
      const source = localSources.get(src)
      if (!source && !response?.ok) {
        throw new Error('Unable to read pasted image.')
      }
      const blob = await waitForPromiseWithSignal(
        source
          ? readCopiedImage(source, options.signal)
          : response
            ? response.blob()
            : Promise.reject(new Error('Unable to read pasted image.')),
        options.signal
      )
      options.assertCurrent()
      const png = await waitForPromiseWithSignal(convertImageBlobToPng(blob), options.signal)
      options.assertCurrent()
      const contentBase64 = await waitForPromiseWithSignal(blobToBase64(png), options.signal)
      options.assertCurrent()
      const path = await waitForPromiseWithSignal(
        importRuntimeImage(destination.context, contentBase64, destination.destinationDir, {
          ...options,
          access: destination.access
        }),
        options.signal
      )
      replacements.set(src, encodeURIComponent(basename(path)))
    }
    return replacements
  } finally {
    responses.length = 0
  }
}

function replaceImportedImages(content: Fragment, replacements: Map<string, string>): Fragment {
  const nodes: ProseMirrorNode[] = []
  content.forEach((node) => {
    const src = typeof node.attrs.src === 'string' ? replacements.get(node.attrs.src) : undefined
    nodes.push(
      node.type.name === 'image' && src
        ? node.type.create({ ...node.attrs, src }, node.content, node.marks)
        : node.isLeaf
          ? node
          : node.copy(replaceImportedImages(node.content, replacements))
    )
  })
  return Fragment.fromArray(nodes)
}

async function readCopiedImage(
  source: RichMarkdownClipboardImageSource,
  signal: AbortSignal
): Promise<Blob> {
  signal.throwIfAborted()
  source.assertCurrent?.()
  const result = await readLocalImagePreview(
    source.absolutePath,
    undefined,
    source.runtimeContext,
    source.access
  )
  signal.throwIfAborted()
  source.assertCurrent?.()
  if (!result.isBinary || !result.content) {
    throw new Error('Unable to read copied image.')
  }
  assertClipboardImageBase64LengthWithinLimit(result.content.length)
  return new Blob([decodeBase64Bytes(result.content)], { type: result.mimeType ?? 'image/png' })
}

function sameImageFileOwner(
  source: RichMarkdownClipboardImageSource['runtimeContext'],
  destination: RuntimeFileOperationArgs
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
