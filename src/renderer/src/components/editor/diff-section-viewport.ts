import type { editor, IPosition } from 'monaco-editor'
import { isIntentionalEditorScroll } from './editor-scroll-intent'

export function installDiffSectionViewport({
  body,
  viewport,
  scrollContainer,
  diffEditor
}: {
  body: HTMLElement
  viewport: HTMLElement
  scrollContainer: HTMLElement
  diffEditor: editor.IStandaloneDiffEditor
}): () => void {
  let updating = false
  let viewportTop = 0
  let width = 0
  let height = 0
  let visibleTopInset = 0
  let frame = 0
  const original = diffEditor.getOriginalEditor()
  const modified = diffEditor.getModifiedEditor()
  // The file header sticks over the list top while its section scrolls beneath it.
  const header = body.parentElement?.querySelector<HTMLElement>(
    ':scope > [data-diff-section-sticky-header]'
  )

  const getUncoveredTop = (containerTop: number): number =>
    header ? Math.max(0, header.getBoundingClientRect().bottom - containerTop) : 0

  // Match the editor to the visible slice: Monaco's reveal, find and drag logic treat its whole viewport as visible.
  const update = (): void => {
    const containerHeight = scrollContainer.clientHeight
    const bodyHeight = body.clientHeight
    if (updating || containerHeight === 0 || bodyHeight === 0) {
      return
    }
    updating = true
    try {
      // Read all geometry before writing so each update forces at most one layout.
      const nextWidth = body.clientWidth
      const containerTop = scrollContainer.getBoundingClientRect().top
      const bodyTop = body.getBoundingClientRect().top - containerTop
      const uncoveredTop = Math.max(0, getUncoveredTop(containerTop) - bodyTop)
      const headerHeight = header?.offsetHeight ?? 0
      const nextHeight = Math.min(bodyHeight, Math.max(1, containerHeight - headerHeight))
      // The body pads below Monaco's content, and Monaco cannot scroll into that padding.
      const scrollableHeight = Math.min(bodyHeight, modified.getContentHeight())
      viewportTop = Math.round(Math.max(0, Math.min(scrollableHeight - nextHeight, uncoveredTop)))
      // Keep find on screen when the section's end, or a short section, sits partly under the header.
      const nextVisibleTopInset = Math.max(0, Math.min(nextHeight, uncoveredTop - viewportTop))
      viewport.style.top = `${viewportTop}px`
      viewport.style.height = `${nextHeight}px`
      if (visibleTopInset !== nextVisibleTopInset) {
        visibleTopInset = nextVisibleTopInset
        viewport.style.setProperty('--diff-section-visible-top', `${visibleTopInset}px`)
      }
      if (width !== nextWidth || height !== nextHeight) {
        width = nextWidth
        height = nextHeight
        diffEditor.layout({ width, height })
      }
      if (modified.getScrollTop() !== viewportTop) {
        modified.setScrollTop(viewportTop)
      }
    } finally {
      updating = false
    }
  }
  const scheduleUpdate = (): void => {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(update)
  }
  // Mount layout and hidden-region settling also move Monaco; only focused editing, find and marked reveals move the list.
  const hasScrollIntent = (): boolean =>
    original.hasWidgetFocus() ||
    modified.hasWidgetFocus() ||
    isIntentionalEditorScroll(original) ||
    isIntentionalEditorScroll(modified)
  const scrollSub = modified.onDidScrollChange((event) => {
    if (updating || !event.scrollTopChanged) {
      return
    }
    if (hasScrollIntent()) {
      scrollContainer.scrollTop += event.scrollTop - viewportTop
    }
    update()
  })
  // A partly visible section's editor extends past the list edge, where Monaco would let the cursor hide.
  const keepCursorVisible = (codeEditor: editor.ICodeEditor, position: IPosition): void => {
    const cursor = codeEditor.hasTextFocus()
      ? codeEditor.getScrolledVisiblePosition(position)
      : null
    if (!cursor) {
      return
    }
    const containerTop = scrollContainer.getBoundingClientRect().top
    const cursorTop = viewport.getBoundingClientRect().top - containerTop + cursor.top
    const cursorBottom = cursorTop + cursor.height
    const delta =
      cursorBottom > scrollContainer.clientHeight
        ? cursorBottom - scrollContainer.clientHeight
        : Math.min(0, cursorTop - getUncoveredTop(containerTop))
    if (delta !== 0) {
      scrollContainer.scrollTop += delta
      update()
    }
  }
  const cursorSubs = [original, modified].map((codeEditor) =>
    codeEditor.onDidChangeCursorPosition((event) => {
      if (event.source !== 'mouse') {
        keepCursorVisible(codeEditor, event.position)
      }
    })
  )
  const diffSub = diffEditor.onDidUpdateDiff(scheduleUpdate)
  const resizeObserver = new ResizeObserver(scheduleUpdate)
  resizeObserver.observe(body)
  resizeObserver.observe(scrollContainer)
  scrollContainer.addEventListener('scroll', update, { passive: true })
  update()

  return () => {
    cancelAnimationFrame(frame)
    scrollSub.dispose()
    for (const sub of cursorSubs) {
      sub.dispose()
    }
    diffSub.dispose()
    resizeObserver.disconnect()
    scrollContainer.removeEventListener('scroll', update)
  }
}
