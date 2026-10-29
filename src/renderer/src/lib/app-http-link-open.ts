import type { AppState } from '@/store/types'
import { getWorkspaceClientCreationActionPolicy } from './client-creation-action-policy'
import { openHttpLink } from './http-link-routing'

// The store registers itself so link buttons need not import it.
let appStateAccessor: (() => AppState) | null = null

export function registerAppHttpLinkStateAccessor(fn: () => AppState): void {
  appStateAccessor = fn
}

/** Opens a web link from Orca's own UI per the link setting, in the given or active workspace. */
export function openAppHttpLink(url: string, worktreeId?: string | null): void {
  const state = appStateAccessor?.()
  const hostWorktreeId = worktreeId || state?.activeWorktreeId
  // Without a workspace whose browser can open pages, the link has nowhere in Orca to go.
  const canHost =
    state &&
    hostWorktreeId &&
    getWorkspaceClientCreationActionPolicy(state, hostWorktreeId)['managed-browser'].state ===
      'enabled'
  openHttpLink(url, { worktreeId: canHost ? hostWorktreeId : null, allowRemoteInApp: true })
}

type AppHttpLinkAnchorClick = Pick<
  MouseEvent,
  'button' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'preventDefault'
> & { currentTarget: HTMLAnchorElement }

/** A plain anchor click opens via openAppHttpLink; modifier clicks keep the browser default, the system browser. */
export function openAppHttpLinkFromAnchor(
  event: AppHttpLinkAnchorClick,
  worktreeId?: string | null
): void {
  const anchor = event.currentTarget
  if (
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey ||
    !/^https?:$/.test(anchor.protocol)
  ) {
    return
  }
  event.preventDefault()
  openAppHttpLink(anchor.href, worktreeId)
}
