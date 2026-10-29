// @vitest-environment happy-dom
import { act } from 'react'
import { fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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
import {
  agentPickerChoiceSeeds,
  type AgentPickerEntry
} from '../../../../shared/agent-launch-picker'

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
function show(value: AgentPickerEntry) {
  act(() =>
    root.render(
      <TooltipProvider>
        <DropdownMenu defaultOpen modal={false}>
          <DropdownMenuTrigger>New tab</DropdownMenuTrigger>
          <DropdownMenuContent>
            <AgentLaunchPickerMenu
              entries={[value]}
              model={{
                state: 'settled',
                rows: value.rows,
                detection: {
                  detectedIds: [value.agent],
                  isLoading: false,
                  isRefreshing: false,
                  detectionFailed: false,
                  needsServerUpdate: false,
                  refresh: async () => [value.agent]
                }
              }}
              runLaunch={launch}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      </TooltipProvider>
    )
  )
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  launch.mockClear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  show(entry)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it.each([
  { menuLeft: 700, side: 'left' },
  { menuLeft: 20, side: 'right' }
])(
  'places setup beside the whole menu at x=$menuLeft, flipping $side',
  async ({ menuLeft, side }) => {
    // Supply missing browser layout only; the real Popover/Popper computes collision and placement.
    const menu = new DOMRect(menuLeft, 80, 280, 240)
    const row = new DOMRect(menuLeft + 5, 128, 270, 32)
    const trigger = new DOMRect(menuLeft + 248, 132, 24, 24)
    const panel = new DOMRect(0, 0, 384, 480)
    function geometry(element: Element): DOMRect {
      if (
        element.matches('[data-slot="popover-content"]') ||
        (element.hasAttribute('data-radix-popper-content-wrapper') &&
          element.querySelector('[data-slot="popover-content"]'))
      ) {
        return panel
      }
      if (element.matches('[role="menuitem"]')) {
        return row
      }
      if (element.matches('[data-slot="popover-trigger"]')) {
        return trigger
      }
      if (
        element.matches('[role="menu"]') ||
        element.hasAttribute('data-radix-popper-content-wrapper')
      ) {
        return menu
      }
      if (element === document.documentElement || element === document.body) {
        return new DOMRect(0, 0, 1000, 800)
      }
      return new DOMRect()
    }
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element
    ) {
      return geometry(this)
    })
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (
      this: HTMLElement
    ) {
      return geometry(this).width
    })
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
      this: HTMLElement
    ) {
      return geometry(this).height
    })
    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(1000)
    vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(800)
    act(() =>
      document.querySelector<HTMLButtonElement>('button[aria-label="Configure Codex"]')!.click()
    )
    const content = document.querySelector<HTMLElement>('[data-slot="popover-content"]')!
    await waitFor(() => {
      expect(content.dataset.side).toBe(side)
      const transform = content.parentElement!.style.transform.match(
        /translate\(([-\d.]+)px, ([-\d.]+)px\)/
      )
      expect(transform).not.toBeNull()
      const x = Number(transform![1])
      const y = Number(transform![2])
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x + panel.width).toBeLessThanOrEqual(1000)
      expect(y).toBeGreaterThanOrEqual(0)
      expect(y + panel.height).toBeLessThanOrEqual(800)
      if (side === 'left') {
        expect(x + panel.width).toBeLessThanOrEqual(menu.left)
      } else {
        expect(x).toBeGreaterThanOrEqual(menu.right)
      }
    })
    expect(launch).not.toHaveBeenCalled()
  }
)

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
it('keeps setup open while the pointer expands and collapses Arguments', async () => {
  const user = userEvent.setup()
  await user.click(
    document.querySelector<HTMLButtonElement>('button[aria-label="Configure Codex"]')!
  )
  const panel = document.querySelector('[role="dialog"]')!
  expect(panel).not.toBeNull()
  expect(panel.querySelector('textarea[aria-label="Arguments"]')).toBeNull()
  const toggle = panel.querySelector<HTMLButtonElement>('button[aria-label="Toggle Arguments"]')!
  await user.hover(toggle)
  expect(document.querySelector('[role="dialog"]')).toBe(panel)
  await user.click(toggle)
  expect(document.querySelector('[role="dialog"]')).toBe(panel)
  expect(panel.querySelector('textarea[aria-label="Arguments"]')).not.toBeNull()
  await user.click(toggle)
  expect(document.querySelector('[role="dialog"]')).toBe(panel)
  expect(panel.querySelector('textarea[aria-label="Arguments"]')).toBeNull()
  expect(launch).not.toHaveBeenCalled()
})

it('keeps model, permission and Fast badge pointer interactions inside setup, but dismisses outside', async () => {
  show({
    ...entry,
    agent: 'claude',
    label: 'Claude',
    rows: [{ agent: 'claude', kind: 'chat' }],
    ...agentPickerChoiceSeeds('claude', {
      agentPermissionDefault: 'own',
      agentDefaultArgs: {
        claude: `--model opus --settings '{"fastMode":true,"theme":"light"}' --add-dir docs`
      }
    }),
    structured: { model: 'opus', permissionMode: 'own', options: { fastMode: 'true' } },
    catalog: {
      origin: 'probe',
      fetchedAt: 1,
      models: [{ id: 'opus', label: 'Opus', isDefault: true, efforts: [], supportsFastMode: true }]
    }
  })
  const user = userEvent.setup()
  await user.click(
    document.querySelector<HTMLButtonElement>('button[aria-label="Configure Claude"]')!
  )
  const panel = document.querySelector('[role="dialog"]')!
  const model = panel.querySelector<HTMLElement>('[cmdk-item]')!
  await user.hover(model)
  await user.click(model)
  expect(document.querySelector('[role="dialog"]')).toBe(panel)
  await user.click(
    panel.querySelector<HTMLButtonElement>('button[aria-label="Claude permissions"]')!
  )
  await user.click(
    [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((item) =>
      item.textContent?.startsWith('Full access')
    )!
  )
  expect(document.querySelector('[role="dialog"]')).toBe(panel)
  await user.click(panel.querySelector<HTMLButtonElement>('button[aria-label="Toggle Arguments"]')!)
  const chip = panel.querySelector<HTMLButtonElement>('button[aria-label*="Remove --settings"]')!
  expect(chip).not.toBeNull()
  await user.click(chip)
  expect(document.querySelector('[role="dialog"]')).toBe(panel)
  expect(panel.querySelector('button[aria-label*="Remove --settings"]')).toBeNull()
  expect(panel.querySelector<HTMLTextAreaElement>('textarea')?.value).toContain('"theme":"light"')
  await user.click(document.body)
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(launch).not.toHaveBeenCalled()
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

it('still launches today’s default when the row is clicked while its setup is open', async () => {
  const user = userEvent.setup()
  const row = document.querySelector<HTMLElement>('[role="menuitem"]')!
  await user.click(row.querySelector<HTMLButtonElement>('button')!)
  expect(launch).not.toHaveBeenCalled()
  await user.click(row)
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
