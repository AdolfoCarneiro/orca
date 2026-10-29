import type { AppState } from '@/store/types'
import { getWorkspaceClientCreationActionPolicy } from './client-creation-action-policy'
import { openHttpLink } from './http-link-routing'
import { getShortcutPlatform } from './shortcut-platform'

// The store registers itself so link buttons need not import it.
let appStateAccessor: (() => AppState) | null = null

export function registerAppHttpLinkStateAccessor(fn: () => AppState): void {
  appStateAccessor = fn
}

type AppHttpLinkClick = Pick<MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey'>

export type OpenAppHttpLinkOptions = {
  /** The workspace the link belongs to; defaults to the active one. */
  worktreeId?: string | null
  /** The click, so the setting's Shift escape modifier applies. */
  event?: AppHttpLinkClick
}

function isEscapeModifierClick(event: AppHttpLinkClick | undefined): boolean {
  return Boolean(
    event?.shiftKey && (getShortcutPlatform() === 'darwin' ? event.metaKey : event.ctrlKey)
  )
}

/** Opens a web link from Orca's own UI per the link setting, in the given or active workspace. */
export function openAppHttpLink(url: string, options: OpenAppHttpLinkOptions = {}): void {
  const state = appStateAccessor?.()
  const hostWorktreeId = options.worktreeId || state?.activeWorktreeId
  // Without a workspace whose browser can open pages, the link has nowhere in Orca to go.
  const canHost =
    state &&
    hostWorktreeId &&
    getWorkspaceClientCreationActionPolicy(state, hostWorktreeId)['managed-browser'].state ===
      'enabled'
  openHttpLink(url, {
    worktreeId: canHost ? hostWorktreeId : null,
    allowRemoteInApp: true,
    modifierHeld: isEscapeModifierClick(options.event)
  })
}

type AppHttpLinkAnchorClick = AppHttpLinkClick &
  Pick<MouseEvent, 'button' | 'altKey' | 'preventDefault'> & { currentTarget: HTMLAnchorElement }

/** Routes plain and escape-modifier anchor clicks; other modifier clicks keep the browser default. */
export function openAppHttpLinkFromAnchor(
  event: AppHttpLinkAnchorClick,
  worktreeId?: string | null
): void {
  const anchor = event.currentTarget
  const plainClick = !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey
  if (
    event.button !== 0 ||
    !/^https?:$/.test(anchor.protocol) ||
    !(plainClick || isEscapeModifierClick(event))
  ) {
    return
  }
  event.preventDefault()
  openAppHttpLink(anchor.href, { worktreeId, event })
}
