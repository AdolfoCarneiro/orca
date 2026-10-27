/**
 * Custom editor frames see file contents, so they run as `<webview>` guests in their own
 * partition whose network is cut at the session (black-hole proxy, request filter, no
 * permissions) instead of as iframes of Orca's renderer, which shares the app's network.
 */

/** In-memory: nothing a plugin stores outlives the app or reaches other sessions. */
export const PLUGIN_EDITOR_PARTITION = 'orca-plugin-editor'
export const PLUGIN_EDITOR_SCHEME = 'orca-plugin-editor'

/** Why a closed loopback port: Chromium never falls back to direct, so every proxied connection
 *  (WebRTC TCP included) fails at once instead of reaching the network. */
export const PLUGIN_EDITOR_BLACKHOLE_PROXY = 'socks5://127.0.0.1:9'

/** Renderer → main: open a guest for one editor. */
export const PLUGIN_EDITOR_OPEN_GUEST_CHANNEL = 'plugins:openCustomEditorGuest'
export const PLUGIN_EDITOR_CLOSE_GUEST_CHANNEL = 'plugins:closeCustomEditorGuest'
/** Guest preload → main: a message the editor posted. */
export const PLUGIN_EDITOR_GUEST_POST_CHANNEL = 'plugin-editor-guest:post'
/** Renderer → guest preload (webview.send): a message for the editor. */
export const PLUGIN_EDITOR_GUEST_DELIVER_CHANNEL = 'plugin-editor-guest:deliver'
/** Main → renderer: what a guest sent, or a key chord the user really pressed in it. */
export const PLUGIN_EDITOR_GUEST_EVENT_CHANNEL = 'plugins:customEditorGuestEvent'

const TOKEN_PATTERN = /^[0-9a-f]{32}$/

export type PluginEditorGuestKeyChord = {
  key: string
  code: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

export type PluginEditorGuestEvent =
  | { token: string; kind: 'message'; data: unknown }
  /** From main's view of real input; the guest's own code cannot produce one. */
  | { token: string; kind: 'keydown'; chord: PluginEditorGuestKeyChord }

export type PluginEditorGuestTicket = {
  token: string
  src: string
  /** From the installed manifest, which main enforces; the tab can only narrow it. */
  readonly: boolean
}

/** `revision` changes only when the editor's bytes do, so a plugin-list refresh can skip a remount. */
export type PluginEditorGuestOpenResult = PluginEditorGuestTicket & { revision: string }

export function pluginEditorGuestUrl(token: string): string {
  return `${PLUGIN_EDITOR_SCHEME}://${token}/`
}

/** The guest token of a URL on the editor scheme, or null. */
export function pluginEditorGuestToken(url: string): string | null {
  const prefix = `${PLUGIN_EDITOR_SCHEME}://`
  if (!url.startsWith(prefix)) {
    return null
  }
  const token = url.slice(prefix.length).split(/[/?#]/, 1)[0] ?? ''
  return TOKEN_PATTERN.test(token) ? token : null
}

export function isPluginEditorGuestToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_PATTERN.test(value)
}
