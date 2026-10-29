import { useLayoutEffect, type RefObject } from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import type { CombinedDiffLoadScheduler } from './combined-diff-load-scheduler'

export function useCombinedDiffSectionPrefetch({
  loadSection,
  schedulerRef,
  sectionCount,
  virtualizer
}: {
  loadSection: (index: number) => void
  schedulerRef: RefObject<CombinedDiffLoadScheduler>
  sectionCount: number
  virtualizer: Virtualizer<HTMLDivElement, Element>
}): void {
  const virtualItems = virtualizer.getVirtualItems()
  useLayoutEffect(() => {
    const range = virtualizer.range
    if (!range) {
      return
    }
    for (
      let index = Math.max(0, range.startIndex - 2);
      index <= Math.min(sectionCount - 1, range.endIndex + 2);
      index += 1
    ) {
      loadSection(index)
    }
    schedulerRef.current.prioritize(
      virtualItems
        .filter((item) => item.index >= range.startIndex && item.index <= range.endIndex)
        .map((item) => item.index)
    )
  }, [loadSection, schedulerRef, sectionCount, virtualItems, virtualizer])
}
