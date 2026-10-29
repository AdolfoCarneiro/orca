// @vitest-environment happy-dom
import { handleOscLink } from '@/components/terminal-pane/terminal-osc-link-routing'
import type { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerHttpLinkStoreAccessor } from '@/lib/http-link-routing'
import type { TerminalLinkActionRequest } from '@/components/terminal-pane/terminal-link-action-request'
import { installPreviewTerminalRightClickPaste } from './preview-terminal-right-click-paste'
import { installPreviewTerminalLinks } from './preview-terminal-links'

const harness = vi.hoisted<{
  error: ReturnType<typeof vi.fn>
  web: null | {
    activate: (event: MouseEvent, uri: string) => void
    hover: (event: MouseEvent, uri: string) => void
    leave: () => void
  }
}>(() => ({ web: null, error: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: harness.error } }))
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
  },
  config: { actions?: boolean; background?: boolean; rightClickPaste?: boolean } = {}
) {
  const element = document.createElement('div')
  document.body.append(element)
  const options: Terminal['options'] = {}
  const request = vi.fn<(request: TerminalLinkActionRequest) => void>()
  const clearSelection = vi.fn()
  const onNavigate = vi.fn()
  const terminal = {
    element,
    options,
    hasSelection: () => false,
    getSelection: () => '',
    clearSelection,
    focus: vi.fn(),
    loadAddon: vi.fn(),
    registerLinkProvider: vi.fn(() => ({ dispose: vi.fn() }))
  }
  disposers.push(() => element.remove())
  disposers.push(
    installPreviewTerminalLinks(terminal, {
      getSettings: () => ({
        openLinksInAppInBackground: config.background,
        terminalRightClickToPaste: config.rightClickPaste
      }),
      linkRouting:
        config.actions === false
          ? undefined
          : {
              getContext: () => ({
                worktreeId: 'wt',
                worktreePath: '/repo',
                sourceOwner: { kind: 'local' },
                actionDestinations: destinations
              }),
              request,
              onNavigate
            }
    })
  )
  return { terminal, request, clearSelection, element, onNavigate }
}

const url = 'https://github.com/stablyai/orca/pull/34229'
const range = { start: { x: 1, y: 1 }, end: { x: 2, y: 1 } }

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

  it('hands off foreground internal actions and preserves external/background preview context', () => {
    const foreground = install()
    foreground.terminal.options.linkHandler?.activate(
      new MouseEvent('click', { metaKey: true }),
      url,
      range
    )
    expect(foreground.onNavigate).toHaveBeenCalledOnce()
    foreground.onNavigate.mockClear()
    harness.web?.activate(new MouseEvent('click', { metaKey: true, shiftKey: true }), url)
    expect(foreground.onNavigate).not.toHaveBeenCalled()
    foreground.terminal.element.dispatchEvent(new MouseEvent('mousedown'))
    harness.web?.activate(new MouseEvent('click'), url)
    foreground.request.mock.calls[0]?.[0].primary.run()
    expect(foreground.onNavigate).toHaveBeenCalledOnce()

    registerHttpLinkStoreAccessor(() => ({
      settings: { openLinksInAppInBackground: true },
      createBrowserTab,
      setActiveWorktree: vi.fn()
    }))
    const background = install(undefined, { background: true })
    background.element.dispatchEvent(new MouseEvent('mousedown'))
    harness.web?.activate(new MouseEvent('click'), url)
    background.request.mock.calls[0]?.[0].primary.run()
    expect(background.onNavigate).not.toHaveBeenCalled()
    expect(createBrowserTab).toHaveBeenLastCalledWith('wt', url, { activate: false })
  })

  it('keeps plain SSH modifier-only destinations and opener failures on the shared path', async () => {
    const { terminal, request } = install(undefined, { actions: false })
    const failure = new Error('browser unavailable')
    openUrl.mockRejectedValueOnce(failure)
    terminal.options.linkHandler?.activate(new MouseEvent('click', { metaKey: true }), url, range)
    await Promise.resolve()
    expect(openUrl).toHaveBeenCalledExactlyOnceWith(url)
    expect(request).not.toHaveBeenCalled()
    expect(createBrowserTab).not.toHaveBeenCalled()
    harness.web?.activate(new MouseEvent('click', { metaKey: true }), url)
    expect(openUrl).toHaveBeenCalledTimes(2)
    harness.web?.activate(new MouseEvent('click'), url)
    expect(openUrl).toHaveBeenCalledTimes(2)
  })

  it('matches the existing shared destination and failure result for the moved system-browser action', async () => {
    const failure = new Error('unavailable')
    const { terminal } = install(undefined, { actions: false })
    openUrl.mockRejectedValue(failure)
    const event = new MouseEvent('click', { metaKey: true })
    handleOscLink(url, event, {
      worktreeId: '',
      worktreePath: '',
      actionDestinations: { primary: 'system' }
    })
    await Promise.resolve()
    terminal.options.linkHandler?.activate(event, url, range)
    await Promise.resolve()
    expect(openUrl.mock.calls).toEqual([[url], [url]])
    expect(harness.error).toHaveBeenCalledTimes(2)
    expect(harness.error.mock.calls[0]).toEqual(harness.error.mock.calls[1])
    openUrl.mockResolvedValue(undefined)
  })

  it('keeps configured right-click paste ahead of link actions and Ctrl-right-click opens the chooser', () => {
    const { terminal, element, request } = install(undefined, { rightClickPaste: true })
    const container = document.createElement('div')
    element.replaceWith(container)
    container.append(element)
    disposers.push(() => container.remove())
    const paste = vi.fn()
    disposers.push(
      installPreviewTerminalRightClickPaste({
        container,
        getTerminal: () => terminal,
        isRightClickToPasteEnabled: () => true,
        pasteClipboardText: paste
      })
    )
    terminal.options.linkHandler?.hover?.(new MouseEvent('mousemove'), url, range)
    element.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })
    )
    expect(paste).toHaveBeenCalledOnce()
    expect(request).not.toHaveBeenCalled()
    element.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, ctrlKey: true })
    )
    expect(request).toHaveBeenCalledOnce()
    expect(paste).toHaveBeenCalledOnce()
  })

  it.each([10, 100])(
    'bounds real global pointer handlers/callbacks with %i retained SSH terminals',
    (population) => {
      const add = EventTarget.prototype.addEventListener
      const remove = EventTarget.prototype.removeEventListener
      const observed = new Set(['mousemove', 'mouseup', 'blur'])
      const records: {
        target: EventTarget
        type: string
        listener: EventListenerOrEventListenerObject
        wrapped: EventListener
      }[] = []
      let callbacks = 0
      vi.spyOn(EventTarget.prototype, 'addEventListener').mockImplementation(function (
        this: EventTarget,
        type,
        listener,
        options
      ) {
        if (listener && observed.has(type) && (this === document || this === window)) {
          const wrapped: EventListener = (event) => {
            callbacks++
            if (typeof listener === 'function') {
              listener.call(this, event)
            } else {
              listener.handleEvent(event)
            }
          }
          records.push({ target: this, type, listener, wrapped })
          add.call(this, type, wrapped, options)
        } else {
          add.call(this, type, listener, options)
        }
      })
      vi.spyOn(EventTarget.prototype, 'removeEventListener').mockImplementation(function (
        this: EventTarget,
        type,
        listener,
        options
      ) {
        const index = records.findIndex(
          (r) => r.target === this && r.type === type && r.listener === listener
        )
        const record = records[index]
        if (record) {
          records.splice(index, 1)
          remove.call(this, type, record.wrapped, options)
        } else {
          remove.call(this, type, listener, options)
        }
      })
      const start = disposers.length
      try {
        for (let i = 0; i < population; i++) {
          install(undefined, { actions: false })
        }
        document.dispatchEvent(new MouseEvent('mousemove'))
        document.dispatchEvent(new MouseEvent('mouseup'))
        window.dispatchEvent(new Event('blur'))
        expect(records).toHaveLength(0)
        expect(callbacks).toBe(0)
        const active = install()
        expect(records).toHaveLength(3)
        active.element.dispatchEvent(new MouseEvent('mousedown'))
        document.dispatchEvent(new MouseEvent('mousemove'))
        harness.web?.activate(new MouseEvent('click'), url)
        expect(active.request).toHaveBeenCalledOnce()
        document.dispatchEvent(new MouseEvent('mouseup'))
        window.dispatchEvent(new Event('blur'))
        expect(callbacks).toBe(3)
        active.element.dispatchEvent(new MouseEvent('mousedown'))
        document.dispatchEvent(new MouseEvent('mousemove', { clientX: 20 }))
        harness.web?.activate(new MouseEvent('click'), url)
        expect(active.request).toHaveBeenCalledOnce()
        disposers
          .splice(start)
          .toReversed()
          .forEach((dispose) => dispose())
        expect(records).toHaveLength(0)
        callbacks = 0
        document.dispatchEvent(new MouseEvent('mousemove'))
        document.dispatchEvent(new MouseEvent('mouseup'))
        window.dispatchEvent(new Event('blur'))
        expect(callbacks).toBe(0)
      } finally {
        disposers
          .splice(start)
          .toReversed()
          .forEach((dispose) => dispose())
        vi.restoreAllMocks()
      }
    }
  )

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
