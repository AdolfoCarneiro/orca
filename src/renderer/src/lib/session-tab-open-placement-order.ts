import type { SessionTabOpenPlacement } from '../../../shared/session-tab-placement'
import type { Tab } from '../../../shared/tab-types'
import {
  insertTabIdIntoOrder,
  partitionPinnedTabOrder
} from '../../../shared/workspace-layout/tab-order'

/** Explicit fallback index retains information absent from a coalesced inventory's neighbours. */
export function insertOpenPlacementTab(
  order: readonly string[],
  tabs: readonly Tab[],
  tabId: string,
  placement: SessionTabOpenPlacement['placement']
): string[] {
  const tab = tabs.find((row) => row.id === tabId)
  const without = order.filter((id) => id !== tabId)
  if (placement.afterTabId && without.includes(placement.afterTabId)) {
    return insertTabIdIntoOrder(without, tabs, tabId, tab?.isPinned === true, placement.afterTabId)
  }
  if (placement.index !== undefined) {
    const index = Math.max(0, Math.min(Math.trunc(placement.index), without.length))
    return index === 0
      ? partitionPinnedTabOrder([...without], tabs, tabId)
      : insertTabIdIntoOrder(without, tabs, tabId, tab?.isPinned === true, without[index - 1])
  }
  return insertTabIdIntoOrder(without, tabs, tabId, tab?.isPinned === true)
}
