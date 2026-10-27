import type { Session, WebContents } from 'electron'
import {
  PLUGIN_EDITOR_BLACKHOLE_PROXY,
  PLUGIN_EDITOR_SCHEME,
  type PluginEditorGuestKeyChord
} from '../../../shared/plugins/plugin-editor-guest'
import { PLUGIN_PANEL_CSP } from '../../../shared/plugins/plugin-panel-shell'

/** Only the editor's own document and inline data ever load; the network is never asked. */
export function isAllowedPluginEditorRequest(url: string): boolean {
  return (
    url.startsWith(`${PLUGIN_EDITOR_SCHEME}://`) ||
    url.startsWith('data:') ||
    url.startsWith('blob:') ||
    url.startsWith('about:')
  )
}

/**
 * Cuts the editor partition off the network at the session, which every frame inside it shares,
 * including `srcdoc` and `javascript:` children that page-level fences never see. The proxy
 * carries what request hooks cannot: WebRTC TCP (with `disable_non_proxied_udp` per guest).
 */
export async function installPluginEditorSessionPolicy(
  editorSession: Session,
  serveDocument: (token: string) => string | null,
  tokenOf: (url: string) => string | null
): Promise<void> {
  await editorSession.setProxy({
    mode: 'fixed_servers',
    proxyRules: PLUGIN_EDITOR_BLACKHOLE_PROXY,
    // Why: Chromium bypasses the proxy for loopback unless told otherwise.
    proxyBypassRules: '<-loopback>'
  })
  await editorSession.closeAllConnections()
  editorSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !isAllowedPluginEditorRequest(details.url) })
  })
  editorSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  editorSession.setPermissionCheckHandler(() => false)
  editorSession.setDevicePermissionHandler(() => false)
  editorSession.setSpellCheckerEnabled(false)
  editorSession.on('will-download', (event) => event.preventDefault())
  editorSession.protocol.handle(PLUGIN_EDITOR_SCHEME, (request) => {
    const token = tokenOf(request.url)
    const html =
      token === null || new URL(request.url).pathname !== '/' ? null : serveDocument(token)
    if (html === null) {
      return new Response('Not found', { status: 404 })
    }
    return new Response(html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': PLUGIN_PANEL_CSP,
        'X-DNS-Prefetch-Control': 'off',
        'Cache-Control': 'no-store'
      }
    })
  })
}

/** Per-guest fences: WebRTC only through the dead proxy, no popups or navigation, and save
 *  chords read from real input before the page sees them, so page code cannot fake one. */
export function hardenPluginEditorGuest(
  guest: WebContents,
  onKeyChord: (chord: PluginEditorGuestKeyChord) => void
): void {
  guest.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
  guest.setWindowOpenHandler(() => ({ action: 'deny' }))
  guest.on('will-navigate', (event) => event.preventDefault())
  guest.on('will-redirect', (event) => event.preventDefault())
  guest.on('before-input-event', (_event, input) => {
    if (input.type !== 'keyDown' || input.isAutoRepeat || !(input.meta || input.control)) {
      return
    }
    onKeyChord({
      key: input.key.slice(0, 64),
      code: input.code.slice(0, 64),
      metaKey: input.meta,
      ctrlKey: input.control,
      altKey: input.alt,
      shiftKey: input.shift
    })
  })
}
