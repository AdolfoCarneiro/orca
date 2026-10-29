// @vitest-environment happy-dom
import type { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerHttpLinkStoreAccessor } from '@/lib/http-link-routing'
import type { TerminalLinkActionRequest } from '@/components/terminal-pane/terminal-link-action-request'
import { installPreviewTerminalLinks } from './preview-terminal-links'

const harness = vi.hoisted(() => ({
  web: null as null | {
    activate: (event: MouseEvent, uri: string) => void
    hover: (event: MouseEvent, uri: string) => void
    leave: () => void
  }
}))
vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class {
    constructor(
      activate: (event: MouseEvent, uri: string) => void,
      options: {
        hover: (event: MouseEvent, uri: string) => void
        leave: () => void
      }
    ) {
      harness.web = { activate, ...options }
    }
  }
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('./preview-terminal-link-context', () => ({
  previewTerminalLinkContext: () => ({
    worktreeId: '',
    worktreePath: '',
    sourceOwner: { kind: 'local' },
    actionDestinations: { primary: 'system' }
  })
}))
const openUrl = vi.fn(async () => {})
const createBrowserTab = vi.fn()
const disposers: (() => void)[] = []

beforeEach(() => {
  vi.stubGlobal('navigator', { userAgent: 'Macintosh' })
  Object.assign(window, { api: { shell: { openUrl } } })
  registerHttpLinkStoreAccessor(() => ({
    settings: { openLinksInApp: true },
    createBrowserTab,
    setActiveWorktree: vi.fn()
  }))
})
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose())
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

function install(
  destinations: { primary: 'orca' | 'system'; alternate?: 'orca' | 'system' } = {
    primary: 'orca',
    alternate: 'system'
  }
) {
  const element = document.createElement('div')
  document.body.append(element)
  const options: Terminal['options'] = {}
  const request = vi.fn<(request: TerminalLinkActionRequest) => void>()
  const clearSelection = vi.fn()
  // SAFETY: installation and gesture routing need only these terminal members; output is not emulated here.
  const terminal = {
    element,
    options,
    hasSelection: () => false,
    clearSelection,
    focus: vi.fn(),
    loadAddon: vi.fn()
  } as unknown as Terminal
  disposers.push(() => element.remove())
  disposers.push(
    installPreviewTerminalLinks(terminal, {
      getSettings: () => null,
      linkRouting: {
        getContext: () => ({
          worktreeId: 'wt',
          worktreePath: '/repo',
          sourceOwner: { kind: 'local' },
          actionDestinations: destinations
        }),
        request
      }
    })
  )
  return { terminal, request, clearSelection, element }
}

const url = 'https://github.com/stablyai/orca/pull/34229'

describe('preview terminal link routes', () => {
  it('routes OSC and detected URLs through the same browser destinations', () => {
    const { terminal, clearSelection } = install()
    const event = new MouseEvent('click', { metaKey: true })
    terminal.options.linkHandler?.activate(event, url, {
      start: { x: 1, y: 1 },
      end: { x: 2, y: 1 }
    })
    harness.web?.activate(new MouseEvent('click', { metaKey: true, shiftKey: true }), url)
    expect(createBrowserTab).toHaveBeenCalledWith('wt', url, { activate: true })
    expect(openUrl).toHaveBeenCalledWith(url)
    expect(clearSelection).toHaveBeenCalledTimes(2)
    expect(terminal.loadAddon).toHaveBeenCalledOnce()
  })

  it('offers the pane actions on ordinary OSC clicks and right-clicked links', () => {
    const { terminal, element, request } = install()
    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    terminal.options.linkHandler?.activate(new MouseEvent('click'), url, {
      start: { x: 1, y: 1 },
      end: { x: 2, y: 1 }
    })
    const left = request.mock.calls[0]?.[0]
    expect(left?.primary.label).toBe('Orca Browser')
    expect(left?.alternate?.label).toBe('System Browser')
    terminal.options.linkHandler?.hover?.(new MouseEvent('mousemove'), url, {
      start: { x: 1, y: 1 },
      end: { x: 2, y: 1 }
    })
    const event = new MouseEvent('contextmenu', { button: 2, cancelable: true })
    element.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(request).toHaveBeenCalledTimes(2)
    request.mock.calls[1]?.[0].alternate?.run()
    expect(openUrl).toHaveBeenCalledWith(url)
  })

  it('keeps pop-out destinations external and ignores unsafe OSC protocols', () => {
    const { terminal, request } = install({ primary: 'system' })
    terminal.options.linkHandler?.activate(new MouseEvent('click', { metaKey: true }), url, {
      start: { x: 1, y: 1 },
      end: { x: 2, y: 1 }
    })
    terminal.options.linkHandler?.activate(
      new MouseEvent('click', { metaKey: true }),
      'javascript:alert(1)',
      {
        start: { x: 1, y: 1 },
        end: { x: 2, y: 1 }
      }
    )
    expect(openUrl).toHaveBeenCalledExactlyOnceWith(url)
    expect(createBrowserTab).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
  })
})
