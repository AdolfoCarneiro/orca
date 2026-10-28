import { useEffect, useRef } from 'react'

export function useRichMarkdownCompletionScroll(selectedIndex: number, rows: readonly unknown[]) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const activeItemRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const viewport = viewportRef.current
    const item = activeItemRef.current
    if (!viewport || !item) {
      return
    }
    const top = viewport.getBoundingClientRect().top + viewport.clientTop
    const bottom = top + viewport.clientHeight
    const rect = item.getBoundingClientRect()
    if (rect.top < top) {
      viewport.scrollTop += rect.top - top
    } else if (rect.bottom > bottom) {
      viewport.scrollTop += rect.bottom - bottom
    }
  }, [selectedIndex, rows])

  return { viewportRef, activeItemRef }
}
