// @vitest-environment happy-dom
import { act } from 'react'
import { fireEvent, waitFor } from '@testing-library/react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AgentLaunchSetupButton } from './AgentLaunchSetupButton'
import { AgentLaunchPickerMenu } from './AgentLaunchPickerMenu'
import type { AgentPickerEntry } from '../../../../shared/agent-launch-picker'

vi.mock('@/hooks/useShortcutLabel', () => ({ useOptionalShortcutLabel: () => null }))
const entry: AgentPickerEntry = {
  agent: 'codex',
  label: 'Codex',
  rows: [{ agent: 'codex', kind: 'chat' }],
  surfaces: ['chat', 'terminal'],
  defaultSurface: 'chat',
  terminal: {},
  structured: {},
  catalog: {
    origin: 'probe',
    fetchedAt: 1,
    models: [
      { id: 'astra', label: 'Astra', isDefault: true, efforts: [{ value: 'low', label: 'Low' }] }
    ]
  }
}
let root: Root
let host: HTMLDivElement
const launch = vi.fn()
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  launch.mockClear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() =>
    root.render(
      <TooltipProvider>
        <DropdownMenu defaultOpen modal={false}>
          <DropdownMenuTrigger>New tab</DropdownMenuTrigger>
          <DropdownMenuContent>
            <AgentLaunchPickerMenu
              entries={[entry]}
              model={{
                state: 'settled',
                rows: entry.rows,
                detection: {
                  detectedIds: ['codex'],
                  isLoading: false,
                  isRefreshing: false,
                  detectionFailed: false,
                  needsServerUpdate: false,
                  refresh: async () => ['codex']
                }
              }}
              runLaunch={launch}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      </TooltipProvider>
    )
  )
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

it('opens setup with a clicked chevron without launching, then dispatches its selected surface once', () => {
  const configure = document.querySelector<HTMLButtonElement>(
    'button[aria-label="Configure Codex"]'
  )
  act(() => configure?.click())
  expect(launch).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain('Arguments')
  const terminal = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === 'Open terminal'
  )
  act(() => terminal?.click())
  expect(launch).toHaveBeenCalledTimes(1)
  expect(launch.mock.calls[0]).toMatchObject([
    { agent: 'codex', kind: 'cli' },
    { agent: 'codex', surface: 'terminal', choices: {} },
    entry
  ])
})
it('opens a searched setup only from its chevron and launches the alternate way from its footer', () => {
  const input = document.querySelector('input')
  act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(
      input,
      'astra low'
    )
    input?.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const row = document.querySelector<HTMLElement>('[role="menuitem"]')!
  expect(row.querySelectorAll('button')).toHaveLength(1)
  expect(document.querySelector('button[aria-label="Open terminal"]')).toBeNull()
  act(() => row.querySelector<HTMLButtonElement>('button')?.click())
  expect(launch).not.toHaveBeenCalled()
  const alternate = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === 'Open terminal'
  )
  act(() => alternate?.click())
  expect(launch).toHaveBeenCalledTimes(1)
  expect(launch.mock.calls[0][1]).toMatchObject({
    surface: 'terminal',
    choices: { model: 'astra', options: { effort: 'low' } }
  })
  expect(document.querySelector('[role="menu"]')).toBeNull()
})

it('shows only the chevron and keeps a plain row click free of setup overrides', () => {
  const row = document.querySelector<HTMLElement>('[role="menuitem"]')!
  expect(
    [...row.querySelectorAll('button')].map((button) => button.getAttribute('aria-label'))
  ).toEqual(['Configure Codex'])
  act(() => row.click())
  expect(launch).toHaveBeenCalledExactlyOnceWith(entry.rows[0], undefined)
  expect(document.querySelector('[role="menu"]')).toBeNull()
})

it('launches the row default with Enter once, without opening setup', () => {
  const row = document.querySelector<HTMLElement>('[role="menuitem"]')!
  act(() => {
    row.focus()
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  expect(launch).toHaveBeenCalledExactlyOnceWith(entry.rows[0], undefined)
  expect(document.querySelector('input[aria-label="Search models"]')).toBeNull()
  expect(document.querySelector('[role="menu"]')).toBeNull()
})

it('still launches today’s default when the row is clicked while its setup is open', () => {
  const row = document.querySelector<HTMLElement>('[role="menuitem"]')!
  act(() => row.querySelector<HTMLButtonElement>('button')?.click())
  expect(launch).not.toHaveBeenCalled()
  act(() => row.click())
  expect(launch).toHaveBeenCalledExactlyOnceWith(entry.rows[0], undefined)
})

it('lets the chevron return keyboard focus to its row without opening or launching', () => {
  const configure = document.querySelector<HTMLButtonElement>(
    'button[aria-label="Configure Codex"]'
  )
  act(() => {
    configure?.focus()
    configure?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
  })
  expect(document.activeElement?.getAttribute('role')).toBe('menuitem')
  expect(document.body.textContent).not.toContain('Arguments')
  expect(launch).not.toHaveBeenCalled()
})

it('launches the searched default once from Enter', () => {
  const input = document.querySelector('input')!
  act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(
      input,
      'astra low'
    )
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  act(() =>
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    )
  )
  expect(launch).toHaveBeenCalledOnce()
  expect(launch.mock.calls[0][1]).toMatchObject({
    surface: 'chat',
    choices: { model: 'astra', options: { effort: 'low' } }
  })
})

it('closes Configure with Escape without dispatch and returns focus to its trigger', async () => {
  const configure = document.querySelector<HTMLButtonElement>(
    'button[aria-label="Configure Codex"]'
  )!
  act(() => configure.click())
  const search = document.querySelector<HTMLInputElement>('input[aria-label="Search models"]')!
  act(() => {
    search.focus()
    search.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    )
  })
  expect(launch).not.toHaveBeenCalled()
  expect(document.querySelector('input[aria-label="Search models"]')).toBeNull()
  await waitFor(() => expect(document.activeElement).toBe(configure))
})

it('unmounts the setup draft on close/reopen and resets an open draft when its owner is replaced', () => {
  const own = {
    ...entry,
    ownerKey: 'pair7/runtime1',
    defaultSurface: 'terminal' as const,
    arguments: '--add-dir docs',
    terminal: { permissionMode: 'ask' as const }
  }
  const show = (value = own) =>
    act(() =>
      root.render(
        <TooltipProvider>
          <AgentLaunchSetupButton entry={value} onUse={launch} />
        </TooltipProvider>
      )
    )
  show()
  const configure = () =>
    document.querySelector<HTMLButtonElement>('button[aria-label="Configure Codex"]')!
  fireEvent.click(configure())
  fireEvent.change(document.querySelector('textarea')!, { target: { value: '--add-dir src' } })
  expect(document.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('--add-dir src')
  fireEvent.keyDown(document.querySelector('textarea')!, { key: 'Escape' })
  expect(document.querySelector('textarea')).toBeNull()
  fireEvent.click(configure())
  expect(document.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('--add-dir docs')
  fireEvent.change(document.querySelector('textarea')!, {
    target: { value: '--add-dir old-owner' }
  })
  show({ ...own, ownerKey: 'pair8/runtime2', arguments: '--add-dir new-owner' })
  expect(document.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe('--add-dir new-owner')
  fireEvent.click(
    [...document.querySelectorAll('button')].find((b) => b.textContent === 'Open terminal')!
  )
  expect(launch).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ choices: {}, arguments: undefined })
  )
})

it('reopens a form selection in the same setup panel and uses it without launching', () => {
  const initial = {
    agent: 'codex' as const,
    surface: 'terminal' as const,
    choices: { model: 'astra', options: { effort: 'low' } }
  }
  act(() =>
    root.render(
      <TooltipProvider>
        <AgentLaunchSetupButton entry={entry} initial={initial} mode="select" onUse={launch} />
      </TooltipProvider>
    )
  )
  fireEvent.click(
    document.querySelector<HTMLButtonElement>('button[aria-label="Configure Codex"]')!
  )
  expect(launch).not.toHaveBeenCalled()
  expect(document.body.textContent).not.toContain('Open terminal')
  fireEvent.click(
    [...document.querySelectorAll('button')].find((button) => button.textContent === 'Use')!
  )
  expect(launch).toHaveBeenCalledExactlyOnceWith(initial)
})
