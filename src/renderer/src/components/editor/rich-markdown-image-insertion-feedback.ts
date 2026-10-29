import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

export function showRichMarkdownImageInsertionCanceled(importedFileKept = false): void {
  toast.info(
    importedFileKept
      ? translate(
          'auto.components.editor.richMarkdownImageInsertionFeedback.importedFileKept',
          'Image insertion canceled because the destination changed. The imported file was kept.'
        )
      : translate(
          'auto.components.editor.richMarkdownImageInsertionFeedback.destinationChanged',
          'Image insertion canceled because the destination changed. Try again.'
        )
  )
}

export function showRichMarkdownImageInsertionProgress(signal: AbortSignal): void {
  if (signal.aborted) {
    return
  }
  let toastId: ReturnType<typeof toast.loading> | undefined
  const timer = setTimeout(() => {
    toastId = toast.loading(
      translate(
        'auto.components.editor.richMarkdownImageInsertionFeedback.importing',
        'Importing images...'
      )
    )
  }, 200)
  signal.addEventListener(
    'abort',
    () => {
      clearTimeout(timer)
      if (toastId !== undefined) {
        toast.dismiss(toastId)
      }
    },
    { once: true }
  )
}
