// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { PluginFilterPopover } from './PluginFilterPopover'
import { NO_PLUGIN_LIST_FILTER } from './plugin-list-filter'

vi.mock('../../ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

describe('PluginFilterPopover', () => {
  it('shows each category with the same icon as its card badge', () => {
    Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
    const container = document.createElement('div')
    const root = createRoot(container)
    act(() =>
      root.render(
        <PluginFilterPopover
          filter={NO_PLUGIN_LIST_FILTER}
          categories={[
            ['themes', 2],
            ['languages', 1]
          ]}
          sources={[]}
          onChange={vi.fn()}
        />
      )
    )
    const option = (category: string): Element | null =>
      container.querySelector(`label[for="plugin-filter-category-${category}"]`)
    expect(option('themes')?.querySelector('svg.lucide-palette')).not.toBeNull()
    expect(option('languages')?.querySelector('svg.lucide-languages')).not.toBeNull()
    act(() => root.unmount())
  })
})
