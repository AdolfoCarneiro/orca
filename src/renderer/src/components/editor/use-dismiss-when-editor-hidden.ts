import { useEffect, useRef } from 'react'

// Portaled editor overlays outlive a hidden editor (inactive tab or workspace), so close them instead.
export function useDismissWhenEditorHidden(
  editorRoot: HTMLElement | null,
  onDismiss: () => void
): void {
  const onDismissRef = useRef(onDismiss)
  onDismissRef.current = onDismiss

  useEffect(() => {
    if (!editorRoot || typeof IntersectionObserver === 'undefined') {
      return
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry && !entry.isIntersecting && editorRoot.getClientRects().length === 0) {
        onDismissRef.current()
      }
    })
    observer.observe(editorRoot)
    return () => observer.disconnect()
  }, [editorRoot])
}
