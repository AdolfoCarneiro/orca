// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand/vanilla'
import type { PersistedUIState } from '../../../../../shared/persisted-ui-state-types'
import type { AppState } from '@/store/types'
import { createUIStore, makePersistedUI } from '@/store/slices/ui-slice-test-harness'
import { PluginsAlphaNotice } from './PluginsAlphaNotice'

const harness = vi.hoisted(() => {
  const state: { store?: StoreApi<AppState> } = {}
  return state
})

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: AppState) => unknown) => {
    if (!harness.store) {
      throw new Error('store not launched')
    }
    return selector(harness.store.getState())
  }
}))

describe('PluginsAlphaNotice', () => {
  let persisted: PersistedUIState
  let container: HTMLDivElement
  let root: Root

  // Simulates an app launch: a fresh store hydrated from what the last session persisted.
  function launch(): void {
    const store = createUIStore()
    store.getState().hydratePersistedUI(persisted)
    harness.store = store
    act(() => root.render(<PluginsAlphaNotice />))
    store.subscribe(() => act(() => root.render(<PluginsAlphaNotice />)))
  }

  beforeEach(() => {
    Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
    persisted = makePersistedUI()
    vi.stubGlobal('window', {
      ...window,
      api: {
        ui: {
          set: vi.fn((updates: Partial<PersistedUIState>) => {
            persisted = { ...persisted, ...updates }
            return Promise.resolve()
          })
        }
      }
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
    harness.store = undefined
  })

  it('shows by default and stays dismissed across a reload', () => {
    launch()
    expect(container.textContent).toContain('Alpha:')
    expect(container.textContent).toContain('The plugin interface may change. Expect nuances.')

    const dismiss = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Dismiss Alpha notice"]'
    )
    if (!dismiss) {
      throw new Error('dismiss button missing')
    }
    act(() => dismiss.click())
    expect(container.textContent).toBe('')
    expect(persisted.pluginsAlphaNoticeDismissed).toBe(true)

    launch()
    expect(container.textContent).toBe('')
  })
})
