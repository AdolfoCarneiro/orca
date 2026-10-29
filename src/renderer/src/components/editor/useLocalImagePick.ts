import { useCallback, useLayoutEffect, useRef } from 'react'
import type { Editor } from '@tiptap/react'
import { toast } from 'sonner'
import { insertRichMarkdownImageFromPath } from './rich-markdown-image-insert'
import { extractIpcErrorMessage } from './rich-markdown-ipc-error-message'
import {
  showRichMarkdownImageInsertionCanceled,
  showRichMarkdownImageInsertionProgress
} from './rich-markdown-image-insertion-feedback'
import {
  captureRichMarkdownImageInsertionTarget,
  type RichMarkdownImageInsertionTarget
} from './rich-markdown-image-insertion-target'

export function useLocalImagePick(
  editor: Editor | null,
  filePath: string,
  worktreeId: string | null,
  runtimeEnvironmentId?: string | null
): () => Promise<void> {
  const pendingTargetsRef = useRef(new Set<RichMarkdownImageInsertionTarget>())
  useLayoutEffect(() => {
    const pendingTargets = pendingTargetsRef.current
    return () => {
      pendingTargets.forEach((target) => target.dispose())
      pendingTargets.clear()
    }
  }, [editor, filePath, runtimeEnvironmentId, worktreeId])

  return useCallback(() => {
    if (!editor) {
      return Promise.resolve()
    }
    const target = captureRichMarkdownImageInsertionTarget(editor)
    if (!target) {
      return Promise.resolve()
    }
    const pendingTargets = pendingTargetsRef.current
    pendingTargets.add(target)
    return insertPickedImage(target, pendingTargets, {
      filePath,
      worktreeId,
      runtimeEnvironmentId
    })
  }, [editor, filePath, runtimeEnvironmentId, worktreeId])
}

async function insertPickedImage(
  target: RichMarkdownImageInsertionTarget,
  pendingTargets: Set<RichMarkdownImageInsertionTarget>,
  location: {
    filePath: string
    worktreeId: string | null
    runtimeEnvironmentId?: string | null
  }
): Promise<void> {
  try {
    const srcPath = await window.api.shell.pickImage()
    if (!srcPath) {
      return
    }
    if (!target.getRange()) {
      showRichMarkdownImageInsertionCanceled()
      return
    }
    showRichMarkdownImageInsertionProgress(target.signal)
    await insertRichMarkdownImageFromPath({
      getEditor: target.getEditor,
      ...location,
      sourcePath: srcPath,
      getInsertionRange: target.getRange
    })
  } catch (err) {
    toast.error(extractIpcErrorMessage(err, 'Failed to insert image.'))
  } finally {
    target.dispose()
    pendingTargets.delete(target)
  }
}
