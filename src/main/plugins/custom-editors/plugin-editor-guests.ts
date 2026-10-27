import { createHash, randomBytes } from 'node:crypto'
import { session, type Session, type WebContents } from 'electron'
import { isCustomEditorEditAttempt } from '../../../shared/plugins/plugin-custom-editor-bridge'
import {
  PLUGIN_EDITOR_GUEST_EVENT_CHANNEL,
  PLUGIN_EDITOR_GUEST_POST_CHANNEL,
  PLUGIN_EDITOR_PARTITION,
  pluginEditorGuestToken,
  pluginEditorGuestUrl,
  type PluginEditorGuestEvent,
  type PluginEditorGuestOpenResult
} from '../../../shared/plugins/plugin-editor-guest'
import { fillPluginFrameShell } from '../../../shared/plugins/plugin-panel-shell'
import {
  hardenPluginEditorGuest,
  installPluginEditorSessionPolicy
} from './plugin-editor-guest-policy'

type GuestRecord = {
  html: string
  readonly: boolean
  hostId: number
}

/** Live guests by token. A token is the guest's origin, so the guest URL names its record. */
const guests = new Map<string, GuestRecord>()
const watchedHosts = new Set<number>()
let editorSession: Session | null = null
let editorSessionReady: Promise<Session> | null = null

function ensureEditorSession(): Promise<Session> {
  editorSessionReady ??= (async () => {
    const created = session.fromPartition(PLUGIN_EDITOR_PARTITION)
    await installPluginEditorSessionPolicy(
      created,
      (token) => guests.get(token)?.html ?? null,
      pluginEditorGuestToken
    )
    editorSession = created
    return created
  })()
  return editorSessionReady
}

/** Guest identity checks must not materialize the session. */
export function isPluginEditorSession(candidate: Session): boolean {
  return editorSession !== null && candidate === editorSession
}

export type PluginEditorGuestOpenRequest = {
  html: string
  readonly: boolean
  colorScheme: 'light' | 'dark'
  tokens: string
}

/** Opens a guest for one editor document; the revision lets a remount skip identical bytes. */
export async function openPluginEditorGuest(
  host: WebContents,
  request: PluginEditorGuestOpenRequest
): Promise<PluginEditorGuestOpenResult> {
  await ensureEditorSession()
  const token = randomBytes(16).toString('hex')
  guests.set(token, {
    html: fillPluginFrameShell(request.html, request.colorScheme, request.tokens),
    readonly: request.readonly,
    hostId: host.id
  })
  if (!watchedHosts.has(host.id)) {
    watchedHosts.add(host.id)
    const hostId = host.id
    host.once('destroyed', () => {
      watchedHosts.delete(hostId)
      releaseHostGuests(hostId)
    })
  }
  return {
    token,
    src: pluginEditorGuestUrl(token),
    readonly: request.readonly,
    revision: createHash('sha256').update(request.html).digest('hex')
  }
}

export function closePluginEditorGuest(host: WebContents, token: unknown): void {
  if (typeof token === 'string' && guests.get(token)?.hostId === host.id) {
    guests.delete(token)
  }
}

function releaseHostGuests(hostId: number): void {
  for (const [token, record] of guests) {
    if (record.hostId === hostId) {
      guests.delete(token)
    }
  }
}

/** A webview may only attach into the editor partition to load a live guest of its own host. */
export function isAdmissiblePluginEditorAttach(
  host: WebContents,
  partition: string,
  src: string
): boolean {
  const token = pluginEditorGuestToken(src)
  return (
    partition === PLUGIN_EDITOR_PARTITION &&
    token !== null &&
    src === pluginEditorGuestUrl(token) &&
    guests.get(token)?.hostId === host.id
  )
}

function recordOf(guest: WebContents, host: WebContents): [string, GuestRecord] | null {
  const token = pluginEditorGuestToken(guest.getURL())
  const record = token === null ? undefined : guests.get(token)
  return token !== null && record && record.hostId === host.id ? [token, record] : null
}

function send(host: WebContents, event: PluginEditorGuestEvent): void {
  if (!host.isDestroyed()) {
    host.send(PLUGIN_EDITOR_GUEST_EVENT_CHANNEL, event)
  }
}

/** Relays what the guest posts to the tab hosting it. Main enforces `readonly` here, so a
 *  viewer's edits never reach the renderer; save chords come only from real input. */
export function attachPluginEditorGuest(guest: WebContents, host: WebContents): void {
  hardenPluginEditorGuest(guest, (chord) => {
    const found = recordOf(guest, host)
    if (found) {
      send(host, { token: found[0], kind: 'keydown', chord })
    }
  })
  guest.ipc.on(PLUGIN_EDITOR_GUEST_POST_CHANNEL, (event, data: unknown) => {
    const found = event.sender === guest ? recordOf(guest, host) : null
    if (!found || (found[1].readonly && isCustomEditorEditAttempt(data))) {
      return
    }
    send(host, { token: found[0], kind: 'message', data })
  })
}

/** Test seam: forget every guest and the session. */
export function resetPluginEditorGuestsForTests(): void {
  guests.clear()
  watchedHosts.clear()
  editorSession = null
  editorSessionReady = null
}
