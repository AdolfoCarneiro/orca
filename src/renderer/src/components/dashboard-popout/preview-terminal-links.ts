import type { Terminal } from '@xterm/xterm'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { installGuardedLinkProviderRegistration } from '@/lib/pane-manager/terminal-link-provider-guard'
import { handleOscLink } from '@/components/terminal-pane/terminal-osc-link-routing'
import { installTerminalLinkPointerGesture } from '@/components/terminal-pane/terminal-link-pointer-gesture'
import { terminalLinkClickBehaviorFor } from '@/components/terminal-pane/terminal-link-click-behavior'
import { isWindowsUserAgent } from '@/components/terminal-pane/pane-helpers'
import type { TerminalLinkActionRequester } from '@/components/terminal-pane/terminal-link-action-request'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { TERMINAL_HTTP_URL_REGEX } from '../../../../shared/terminal-http-url-extraction'
import { previewTerminalLinkContext } from './preview-terminal-link-context'

export type PreviewTerminalLinkRouting = {
  getContext: () => ReturnType<typeof previewTerminalLinkContext>
  request: TerminalLinkActionRequester
}

/** Share pane actions for OSC and detected URLs; retain the preview's single URL provider. */
export function installPreviewTerminalLinks(
  terminal: Terminal,
  deps: { getSettings: () => GlobalSettings | null; linkRouting?: PreviewTerminalLinkRouting }
): () => void {
  installGuardedLinkProviderRegistration(terminal)
  const pointerGesture = installTerminalLinkPointerGesture(terminal)
  let hoveredLink: string | null = null
  const activate = (event: MouseEvent, uri: string): boolean => {
    const context = deps.linkRouting?.getContext() ?? previewTerminalLinkContext()
    const handled = handleOscLink(uri, event, {
      ...context,
      linkActionContext: deps.linkRouting && {
        paneId: 0,
        pointerGesture,
        claimPtyMouse: () => true,
        request: deps.linkRouting.request,
        focusTerminal: () => terminal.focus(),
        plainClickBehavior: terminalLinkClickBehaviorFor(deps.getSettings()),
        sourceOwner: context.sourceOwner
      }
    })
    if (handled) {
      terminal.clearSelection()
    }
    return handled
  }
  const hover = (_event: MouseEvent, uri: string): void => {
    hoveredLink = uri
  }
  const leave = (): void => {
    hoveredLink = null
  }
  const previousHandler = terminal.options.linkHandler
  const linkHandler = { allowNonHttpProtocols: true, activate, hover, leave }
  terminal.options.linkHandler = linkHandler
  terminal.loadAddon(
    new WebLinksAddon(activate, { urlRegex: TERMINAL_HTTP_URL_REGEX, hover, leave })
  )
  const contextMenu = (event: MouseEvent): void => {
    const rightClickPaste = deps.getSettings()?.terminalRightClickToPaste ?? isWindowsUserAgent()
    if ((!rightClickPaste || event.ctrlKey) && hoveredLink && activate(event, hoveredLink)) {
      event.stopPropagation()
    }
  }
  terminal.element?.addEventListener('contextmenu', contextMenu)
  return () => {
    pointerGesture.dispose()
    terminal.element?.removeEventListener('contextmenu', contextMenu)
    if (terminal.options.linkHandler === linkHandler) {
      terminal.options.linkHandler = previousHandler
    }
  }
}
