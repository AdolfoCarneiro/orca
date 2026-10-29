const LIVE_WIDTH_PROPERTY = '--workspace-sidebar-live-width'

let liveWidthCss: string | null = null
const targets = new Set<HTMLElement>()

// Why: a custom property on :root restyles the whole document every drag frame; only the drawers read it.
export function setSidebarLiveWidth(width: number): void {
  const next = `${width}px`
  if (next === liveWidthCss) {
    return
  }
  liveWidthCss = next
  for (const target of targets) {
    target.style.setProperty(LIVE_WIDTH_PROPERTY, next)
  }
}

// Ref callback: applies the current width on mount so a drawer opened mid-drag starts at the sidebar edge.
export function trackSidebarLiveWidth(element: HTMLElement | null): (() => void) | undefined {
  if (!element) {
    return undefined
  }
  if (liveWidthCss !== null) {
    element.style.setProperty(LIVE_WIDTH_PROPERTY, liveWidthCss)
  }
  targets.add(element)
  return () => {
    targets.delete(element)
  }
}
