import { createContext, useContext, useLayoutEffect, useSyncExternalStore } from 'react'
import type { RefObject } from 'react'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { executionHostIdForStructuredTarget } from '@/runtime/structured-agent-session-owner'

export type SwitchPresentationVisit = {
  subscribe: (listener: () => void) => () => void
  changed: () => void
  stopObserving?: () => void
  observeRows?: () => void
  itemVisible?: (id: string) => boolean
  presentedItems: Set<string>
  settled: boolean
  failureItemId?: string
  reporter?: 'inline' | 'clicked'
  mounted: boolean
  visible: boolean
  release: () => void
}
const visits = new Map<string, SwitchPresentationVisit>()
const listeners = new Map<string, Set<() => void>>()
const subscribe = (key: string, listener: () => void) => {
  const rows = listeners.get(key) ?? new Set<() => void>()
  rows.add(listener)
  listeners.set(key, rows)
  return () => {
    rows.delete(listener)
    if (!rows.size) {
      listeners.delete(key)
    }
  }
}
const changed = (key: string) => listeners.get(key)?.forEach((listener) => listener())
const keyFor = (target: RuntimeClientTarget, id: string) =>
  `${executionHostIdForStructuredTarget(target)}\0${id}`
export const SwitchPresentationContext = createContext<SwitchPresentationVisit | undefined>(
  undefined
)

/** Only this automatic visit owns the click's selected failure; a later manual visit reads history normally. */
export function beginSwitchPresentation(
  target: RuntimeClientTarget,
  id: string
): SwitchPresentationVisit {
  const key = keyFor(target, id)
  visits.get(key)?.release()
  const visit: SwitchPresentationVisit = {
    subscribe: (listener) => subscribe(key, listener),
    changed: () => changed(key),
    presentedItems: new Set(),
    settled: false,
    mounted: false,
    visible: false,
    release: () => {
      if (visits.get(key) === visit) {
        visit.stopObserving?.()
        visits.delete(key)
        changed(key)
      }
    }
  }
  visits.set(key, visit)
  changed(key)
  return visit
}
export function reportSwitchPresentationFailure(
  visit: SwitchPresentationVisit,
  itemId?: string
): boolean {
  if (visit.reporter) {
    return false
  }
  visit.failureItemId = itemId
  visit.reporter =
    itemId && (visit.presentedItems.has(itemId) || (visit.visible && visit.itemVisible?.(itemId)))
      ? 'inline'
      : 'clicked'
  settleSwitchPresentation(visit)
  return visit.reporter === 'clicked'
}
export function settleSwitchPresentation(visit: SwitchPresentationVisit | undefined): void {
  if (!visit || visit.settled) {
    return
  }
  visit.settled = true
  visit.stopObserving?.()
  visit.presentedItems.clear()
  visit.itemVisible = undefined
  if (!visit.mounted && !visit.reporter) {
    visit.release()
  }
  visit.changed()
}
export function useSwitchPresentation(target: RuntimeClientTarget, id: string, visible: boolean) {
  const key = keyFor(target, id)
  const visit = useSyncExternalStore(
    (listener) => subscribe(key, listener),
    () => visits.get(key),
    () => undefined
  )
  useLayoutEffect(() => {
    if (!visit) {
      return
    }
    visit.mounted = true
    visit.visible = visible
    visit.observeRows?.()

    if (!visible) {
      visit.release()
    }
    return () => {
      visit.visible = false
      visit.release()
    }
  }, [visit, visible])
  return visit
}
export function useSwitchPresentationRows(root: RefObject<HTMLDivElement | null>): void {
  const visit = useContext(SwitchPresentationContext)
  useLayoutEffect(() => {
    if (!visit || visit.settled) {
      return
    }
    const rowVisible = (row: HTMLElement): boolean => {
      const element = root.current
      if (!element || !element.isConnected) {
        return false
      }
      const bounds = element.getBoundingClientRect()
      const rect = row.getBoundingClientRect()
      return (
        bounds.width > 0 &&
        bounds.height > 0 &&
        rect.height > 0 &&
        rect.width > 0 &&
        rect.right > Math.max(0, bounds.left) &&
        rect.left < Math.min(window.innerWidth, bounds.right) &&
        rect.bottom > Math.max(0, bounds.top) &&
        rect.top < Math.min(window.innerHeight, bounds.bottom)
      )
    }
    const itemVisible = (id: string): boolean => {
      for (const row of root.current?.querySelectorAll<HTMLElement>('[data-switch-item-id]') ??
        []) {
        if (row.dataset.switchItemId === id) {
          return rowVisible(row)
        }
      }
      return false
    }
    visit.itemVisible = itemVisible
    const observe = () => {
      if (!visit.visible || visit.settled) {
        return
      }
      for (const row of root.current?.querySelectorAll<HTMLElement>('[data-switch-item-id]') ??
        []) {
        const id = row.dataset.switchItemId
        if (id && rowVisible(row)) {
          visit.presentedItems.add(id)
        }
      }
    }
    observe()
    const element = root.current
    element?.addEventListener('scroll', observe, { passive: true })
    const stop = () => {
      element?.removeEventListener('scroll', observe)
      if (visit.itemVisible === itemVisible) {
        visit.itemVisible = undefined
      }
      if (visit.stopObserving === stop) {
        visit.stopObserving = undefined
      }
      if (visit.observeRows === observe) {
        visit.observeRows = undefined
      }
    }
    visit.stopObserving = stop
    visit.observeRows = observe
    return () => {
      observe()
      stop()
    }
  })
}
export function useSwitchFailureSuppressed(itemId: string | undefined): boolean {
  const visit = useContext(SwitchPresentationContext)
  return useSyncExternalStore(
    visit?.subscribe ?? (() => () => {}),
    () => Boolean(itemId && visit?.failureItemId === itemId && visit.reporter === 'clicked'),
    () => false
  )
}
