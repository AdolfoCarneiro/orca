import type { MarkdownPreviewFoundation } from './use-markdown-preview-foundation'
import type { MarkdownPreviewViewport } from './use-markdown-preview-viewport'

export async function finishMarkdownPreviewReviewNotesCopy(
  copy: Promise<boolean>,
  {
    reviewNotesCopyMountedRef,
    clearReviewNotesCopiedResetTimer,
    setReviewNotesCopied,
    reviewNotesCopiedResetTimerRef
  }: Pick<
    MarkdownPreviewFoundation,
    'reviewNotesCopyMountedRef' | 'setReviewNotesCopied' | 'reviewNotesCopiedResetTimerRef'
  > &
    Pick<MarkdownPreviewViewport, 'clearReviewNotesCopiedResetTimer'>
): Promise<void> {
  try {
    const copied = await copy
    if (!copied || !reviewNotesCopyMountedRef.current) {
      return
    }
    clearReviewNotesCopiedResetTimer()
    setReviewNotesCopied(true)
    reviewNotesCopiedResetTimerRef.current = window.setTimeout(() => {
      reviewNotesCopiedResetTimerRef.current = null
      setReviewNotesCopied(false)
    }, 1600)
  } catch {
    // Best-effort clipboard action; failures usually mean the window is not focused.
  }
}

export async function finishMarkdownPreviewReviewNoteCopy(
  copy: Promise<boolean>,
  noteId: string,
  {
    reviewNotesCopyMountedRef,
    clearCopiedReviewNoteResetTimer,
    setCopiedReviewNoteId,
    copiedReviewNoteResetTimerRef
  }: Pick<
    MarkdownPreviewFoundation,
    'reviewNotesCopyMountedRef' | 'setCopiedReviewNoteId' | 'copiedReviewNoteResetTimerRef'
  > &
    Pick<MarkdownPreviewViewport, 'clearCopiedReviewNoteResetTimer'>
): Promise<void> {
  try {
    const copied = await copy
    if (!copied || !reviewNotesCopyMountedRef.current) {
      return
    }
    clearCopiedReviewNoteResetTimer()
    setCopiedReviewNoteId(noteId)
    copiedReviewNoteResetTimerRef.current = window.setTimeout(() => {
      copiedReviewNoteResetTimerRef.current = null
      setCopiedReviewNoteId(null)
    }, 1600)
  } catch {
    // Best-effort clipboard action; failures usually mean the window is not focused.
  }
}
