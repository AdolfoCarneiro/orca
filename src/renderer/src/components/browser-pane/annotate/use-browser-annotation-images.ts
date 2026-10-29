import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { getConnectionId } from '@/lib/connection-context'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/worktree-runtime-owner'
import { useMountedRef } from '@/hooks/useMountedRef'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { formatClipboardImagePasteError } from '@/components/terminal-pane/terminal-pane-paste-execution'
import { clipboardEventImageFile } from '@/components/native-chat/native-chat-clipboard-payload'
import type { NativeChatComposerImageAttachment } from '@/components/native-chat/NativeChatComposerField'

/** Save where a terminal paste in this worktree would, so the agent can open the path. */
function saveAnnotationClipboardImage(worktreeId: string): Promise<string | null> {
  return window.api.ui.saveClipboardImageAsTempFile({
    connectionId: getConnectionId(worktreeId) ?? null,
    runtimeEnvironmentId: runtimeEnvironmentIdOrLocalUnlessTwin(useAppStore.getState(), worktreeId)
  })
}

export function useBrowserAnnotationImages(worktreeId: string): {
  images: NativeChatComposerImageAttachment[]
  imagePaths: string[]
  saving: boolean
  handlePaste: (event: React.ClipboardEvent) => void
  removeImage: (id: string) => void
  resetImages: (paths?: readonly string[]) => void
} {
  const mountedRef = useMountedRef()
  const [images, setImages] = useState<NativeChatComposerImageAttachment[]>([])
  const previewUrlsRef = useRef(new Map<string, string>())

  const revokePreviews = useCallback((): void => {
    previewUrlsRef.current.forEach((url) => URL.revokeObjectURL(url))
    previewUrlsRef.current.clear()
  }, [])
  useEffect(() => revokePreviews, [revokePreviews])

  const removeImage = useCallback((id: string): void => {
    const previewUrl = previewUrlsRef.current.get(id)
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl)
      previewUrlsRef.current.delete(id)
    }
    setImages((current) => current.filter((image) => image.id !== id))
  }, [])

  const handlePaste = useCallback(
    (event: React.ClipboardEvent): void => {
      // Text wins, as in a terminal: rich copies often carry an image rendition of their text.
      const file = event.clipboardData.getData('text/plain') ? null : clipboardEventImageFile(event)
      if (!file) {
        return
      }
      event.preventDefault()
      const id = createBrowserUuid()
      const previewUrl = URL.createObjectURL(file)
      previewUrlsRef.current.set(id, previewUrl)
      setImages((current) => [...current, { id, path: '', previewUrl, pending: true }])
      const settle = (path: string | null): void => {
        if (!mountedRef.current) {
          return
        }
        if (!path) {
          removeImage(id)
          return
        }
        setImages((current) =>
          current.map((image) => (image.id === id ? { ...image, path, pending: false } : image))
        )
      }
      saveAnnotationClipboardImage(worktreeId).then(settle, (error: unknown) => {
        settle(null)
        toast.error(formatClipboardImagePasteError(error))
      })
    },
    [mountedRef, removeImage, worktreeId]
  )

  const resetImages = useCallback(
    (paths: readonly string[] = []): void => {
      revokePreviews()
      setImages(paths.map((path) => ({ id: path, path })))
    },
    [revokePreviews]
  )

  return {
    images,
    imagePaths: images.flatMap((image) => (image.pending ? [] : [image.path])),
    saving: images.some((image) => image.pending),
    handlePaste,
    removeImage,
    resetImages
  }
}
