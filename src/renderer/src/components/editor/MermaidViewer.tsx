import React, { useCallback, useLayoutEffect, useRef } from 'react'
import { scrollTopCache, setWithLRU } from '@/lib/scroll-cache'
import MermaidBlock from './MermaidBlock'
import { useDocumentDarkTheme } from '@/hooks/use-document-dark-theme'

type MermaidViewerProps = {
  content: string
  scrollCacheKey: string
}

// Render full .mmd/.mermaid files directly as diagram source.
export default function MermaidViewer({
  content,
  scrollCacheKey
}: MermaidViewerProps): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const pendingScrollTopRef = useRef<number | undefined>(undefined)
  const isDark = useDocumentDarkTheme()

  const restorePendingScroll = useCallback(() => {
    const container = rootRef.current
    const targetScrollTop = pendingScrollTopRef.current
    if (container && targetScrollTop !== undefined) {
      container.scrollTop = Math.min(
        targetScrollTop,
        Math.max(0, container.scrollHeight - container.clientHeight)
      )
      pendingScrollTopRef.current = undefined
    }
  }, [])

  useLayoutEffect(() => {
    const container = rootRef.current
    if (!container) {
      return
    }

    let throttleTimer: ReturnType<typeof setTimeout> | null = null

    const onScroll = (): void => {
      if (throttleTimer !== null) {
        clearTimeout(throttleTimer)
      }
      throttleTimer = setTimeout(() => {
        setWithLRU(scrollTopCache, scrollCacheKey, container.scrollTop)
        throttleTimer = null
      }, 150)
    }

    container.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      // Before async SVG renders, zero layout must not overwrite cached scroll during quick switches or Strict Mode remounts.
      if (container.scrollHeight > container.clientHeight || container.scrollTop > 0) {
        setWithLRU(scrollTopCache, scrollCacheKey, container.scrollTop)
      }
      if (throttleTimer !== null) {
        clearTimeout(throttleTimer)
      }
      container.removeEventListener('scroll', onScroll)
    }
  }, [scrollCacheKey])

  useLayoutEffect(() => {
    const container = rootRef.current
    const targetScrollTop = scrollTopCache.get(scrollCacheKey)
    pendingScrollTopRef.current = targetScrollTop
    if (
      container &&
      targetScrollTop !== undefined &&
      container.scrollHeight - container.clientHeight >= targetScrollTop
    ) {
      restorePendingScroll()
    }
    return () => {
      pendingScrollTopRef.current = undefined
    }
  }, [scrollCacheKey, content, restorePendingScroll])

  return (
    <div ref={rootRef} className="mermaid-viewer h-full min-h-0 overflow-auto scrollbar-editor">
      <div className="mermaid-viewer-canvas">
        {/* DOMPurify strips foreignObject HTML labels; request native SVG text so labels survive sanitization. */}
        <MermaidBlock
          content={content.trim()}
          isDark={isDark}
          htmlLabels={false}
          onRenderComplete={restorePendingScroll}
        />
      </div>
    </div>
  )
}
