import type { Editor } from '@tiptap/react'
import type { Slice } from '@tiptap/pm/model'
import { toast } from 'sonner'
import { getConnectionId } from '@/lib/connection-context'
import { useAppStore } from '@/store'
import { requireRuntimeTargetForFileOwner } from '@/lib/file-owner-runtime-target'
import { extractIpcErrorMessage } from './rich-markdown-ipc-error-message'
import { insertRichMarkdownImageFromPath } from './rich-markdown-image-insert'
import { captureRichMarkdownImageInsertionTarget } from './rich-markdown-image-insertion-target'
import {
  showRichMarkdownImageInsertionCanceled,
  showRichMarkdownImageInsertionProgress
} from './rich-markdown-image-insertion-feedback'
import { handleRichMarkdownBlobImagePaste } from './rich-markdown-blob-image-paste'

export type RichMarkdownImagePasteArgs = {
  editor: Editor | null
  event: ClipboardEvent
  filePath: string
  worktreeId: string | null
  runtimeEnvironmentId?: string | null
  slice?: Slice
}

export function clipboardHasImage(event: ClipboardEvent): boolean {
  const data = event.clipboardData
  if (!data) {
    return false
  }
  return Array.from(data.items).some(
    (item) => item.kind === 'file' && item.type.startsWith('image/')
  )
}

export function handleRichMarkdownImagePaste({
  editor,
  event,
  filePath,
  worktreeId,
  runtimeEnvironmentId,
  slice
}: RichMarkdownImagePasteArgs): boolean {
  if (!editor || !clipboardHasImage(event)) {
    return handleRichMarkdownBlobImagePaste({
      editor,
      event,
      filePath,
      worktreeId,
      runtimeEnvironmentId,
      slice
    })
  }

  event.preventDefault()
  const target = captureRichMarkdownImageInsertionTarget(editor)
  if (!target) {
    return true
  }

  showRichMarkdownImageInsertionProgress(target.signal)
  void saveClipboardImageForMarkdownPaste(worktreeId, runtimeEnvironmentId)
    .then((sourcePath) => {
      if (!sourcePath) {
        return
      }
      if (!target.getRange()) {
        showRichMarkdownImageInsertionCanceled()
        return
      }
      return insertRichMarkdownImageFromPath({
        getEditor: target.getEditor,
        filePath,
        sourcePath,
        worktreeId,
        runtimeEnvironmentId,
        getInsertionRange: target.getRange
      })
    })
    .catch((err) => {
      toast.error(extractIpcErrorMessage(err, 'Failed to insert image.'))
    })
    .finally(target.dispose)

  return true
}

async function saveClipboardImageForMarkdownPaste(
  worktreeId: string | null,
  runtimeEnvironmentId?: string | null
): Promise<string | null> {
  const hasRuntimeOwner =
    requireRuntimeTargetForFileOwner(useAppStore.getState(), worktreeId, runtimeEnvironmentId)
      .kind === 'environment'
  // Runtime clipboard imports belong on the runtime host; SSH temp saves would place them on the wrong machine.
  const connectionId = hasRuntimeOwner ? undefined : (getConnectionId(worktreeId) ?? undefined)

  return window.api.ui.saveClipboardImageAsTempFile({ connectionId })
}
