import { PANEL_PING_TYPE, PANEL_PONG_TYPE, PANEL_THEME_TYPE } from './plugin-panel-bridge'

/** Prepend CSP before any untrusted panel HTML: opaque origins alone still permit CORS fetch/beacons. Parsed CSP survives
 * DOM removal and later CSP can only tighten it. Open head/html exposes design tokens to plugin CSS.
 * Shared Electron-free builder keeps desktop and serve wrapping identical. */

// Residual shared with doc preview: Electron 43 resolves `<link rel="dns-prefetch">` outside CSP
// and session hooks (see browser-route-dns-prefetch.electron.test.ts), so DNS labels can still leak.
// Residual WebRTC channel: the prelude removes RTCPeerConnection from the panel window only. A
// child `<iframe srcdoc>` (or `javascript:` src) the panel adds is a fresh realm: srcdoc commits
// without will-frame-navigate, so the frame guard never sees it, and Electron 43 has no CSP
// `webrtc` directive or per-frame switch. That frame can open TURN-over-TCP to any host, which
// `disable_non_proxied_udp` allows (plugin-panel-webrtc.electron.test.ts). Direct child-window
// access is already refused as a sandbox violation. A subframe preload (nodeIntegrationInSubFrames
// on the main window) would cover srcdoc frames but, tested, still misses `javascript:` documents.
export const PLUGIN_PANEL_CSP =
  "default-src 'none'; connect-src 'none'; script-src 'unsafe-inline'; " +
  "style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"

/** Renderer fills theme/tokens before mounting srcdoc; main cannot know the active presentation values. */
export const PANEL_SHELL_TOKENS_PLACEHOLDER = '/*__ORCA_PANEL_TOKENS__*/'
export const PANEL_SHELL_COLOR_SCHEME_PLACEHOLDER = '__ORCA_COLOR_SCHEME__'
const PANEL_SHELL_TOKENS_STYLE_ID = 'orca-design-tokens'

/** Curated design-token subset injected into panel documents as `--orca-<name>`. Deliberately
 *  NOT all of main.css (~257 custom properties): freezing every token as
 *  public API would lock future refactors. Grow additively; renaming or
 *  dropping an entry here is a plugin-facing breaking change. */
export const PANEL_DESIGN_TOKEN_ALLOWLIST = [
  '--background',
  '--foreground',
  '--card',
  '--card-foreground',
  '--popover',
  '--popover-foreground',
  '--primary',
  '--primary-foreground',
  '--secondary',
  '--secondary-foreground',
  '--muted',
  '--muted-foreground',
  '--accent',
  '--accent-foreground',
  '--destructive',
  '--destructive-foreground',
  '--border',
  '--input',
  '--ring',
  '--radius'
] as const

/** Names the frame kind in logs; custom editors get the same shell, in an isolated guest. */
export type PluginFrameSurface = 'panel' | 'custom-editor'

/** Replace only the first shell placeholders, parsed before plugin content, so plugin echoes stay
 *  inert. `tokens` loses structural CSS characters, so it cannot close the style block. */
export function fillPluginFrameShell(
  html: string,
  colorScheme: 'light' | 'dark',
  tokens: string
): string {
  return html
    .replace(PANEL_SHELL_COLOR_SCHEME_PLACEHOLDER, colorScheme)
    .replace(PANEL_SHELL_TOKENS_PLACEHOLDER, () => tokens.replaceAll(/[{}<>]/g, ''))
}

export function buildPluginPanelShellHtml(pluginHtml: string): string {
  // The inline ping responder proves the frame's event loop is alive; the
  // renderer watchdog demotes the panel when pongs stop arriving.
  const prelude =
    '<!doctype html>\n' +
    `<html class="${PANEL_SHELL_COLOR_SCHEME_PLACEHOLDER}">\n` +
    '<head>\n' +
    '<meta charset="utf-8">\n' +
    `<meta http-equiv="Content-Security-Policy" content="${PLUGIN_PANEL_CSP}">\n` +
    `<style id="${PANEL_SHELL_TOKENS_STYLE_ID}">:root{${PANEL_SHELL_TOKENS_PLACEHOLDER}}</style>\n` +
    '<script>\n' +
    "'use strict'\n" +
    '// Host policy: plugin panels are documents, never browsing contexts.\n' +
    "if (window.navigation && typeof window.navigation.addEventListener === 'function') {\n" +
    "  window.navigation.addEventListener('navigate', function (event) {\n" +
    '    if (event.cancelable) event.preventDefault()\n' +
    '  })\n' +
    '}\n' +
    '// Why: CSP has no WebRTC directive, so a peer connection would be an open outbound channel.\n' +
    "['RTCPeerConnection', 'webkitRTCPeerConnection'].forEach(function (name) {\n" +
    '  try { Object.defineProperty(window, name, { value: undefined, writable: false, configurable: false }) }\n' +
    '  catch (_) {}\n' +
    '})\n' +
    "try { Object.defineProperty(window, 'open', { value: function () { return null }, writable: false, configurable: false }) }\n" +
    'catch (_) { try { window.open = function () { return null } } catch (_) {} }\n' +
    "window.addEventListener('click', function (event) {\n" +
    '  var node = event.target\n' +
    '  while (node && node !== document) {\n' +
    "    if (node.nodeType === 1 && node.tagName === 'A' && node.hasAttribute('href')) {\n" +
    '      event.preventDefault()\n' +
    '      event.stopImmediatePropagation()\n' +
    '      return\n' +
    '    }\n' +
    '    node = node.parentNode\n' +
    '  }\n' +
    '}, true)\n' +
    "window.addEventListener('submit', function (event) {\n" +
    '  event.preventDefault()\n' +
    '  event.stopImmediatePropagation()\n' +
    '}, true)\n' +
    "window.addEventListener('message', function (event) {\n" +
    '  var data = event.data\n' +
    `  if (event.source === window.parent && data && data.type === '${PANEL_PING_TYPE}') {\n` +
    `    window.parent.postMessage({ type: '${PANEL_PONG_TYPE}', pingId: data.pingId }, '*')\n` +
    '  }\n' +
    `  if (event.source === window.parent && data && data.type === '${PANEL_THEME_TYPE}' &&\n` +
    "    (data.colorScheme === 'light' || data.colorScheme === 'dark') && typeof data.tokens === 'string') {\n" +
    "    document.documentElement.classList.remove('light', 'dark')\n" +
    '    document.documentElement.classList.add(data.colorScheme)\n' +
    `    var tokens = document.getElementById('${PANEL_SHELL_TOKENS_STYLE_ID}')\n` +
    "    if (tokens) tokens.textContent = ':root{' + data.tokens.replace(/[{}<>]/g, '') + '}'\n" +
    '  }\n' +
    '})\n</script>\n' +
    '</head>\n'
  return prelude + pluginHtml
}
