import { isAbsolute } from 'node:path'
import { isPtyIncarnationId } from '../../shared/pty-incarnation'

export type CodexPaneHomeRoute = 'real-home' | 'shared-home' | 'account-home' | 'wsl-home'
export type CodexLaunchProvenance = { homePath: string; incarnationId: string }

export type CodexPaneAccountRecord = {
  selectionKey: string
  accountId: string | null
  homeRoute?: CodexPaneHomeRoute
  launchProvenance?: CodexLaunchProvenance
}

// Removing the notice lane retains qualified origin/address without exposing a legacy receipt.
export type CodexPaneAccountEntry = Omit<CodexPaneAccountRecord, 'selectionKey'> & {
  selectionKey?: string
}

export type CodexPaneAccountRegistryFile = {
  version: 2
  panes: Record<string, CodexPaneAccountEntry>
  legacyWslAttributionUnknown?: true
}

export type CodexPaneHomeObservation = {
  actualHome: string
  frozenOrigin: Readonly<CodexPaneAccountRecord>
  registration: object
  incarnationId?: string
}

export function isPaneAccountRecord(value: unknown): value is CodexPaneAccountEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  if (
    !('accountId' in value) ||
    !(value.accountId === null || typeof value.accountId === 'string')
  ) {
    return false
  }
  const lane = 'selectionKey' in value ? value.selectionKey : undefined
  return (
    lane === 'host' ||
    (typeof lane === 'string' && /^wsl:.+/.test(lane)) ||
    (lane === undefined &&
      readLaunchProvenance('launchProvenance' in value ? value.launchProvenance : undefined) !==
        undefined)
  )
}

export function readLaunchProvenance(value: unknown): CodexLaunchProvenance | undefined {
  if (
    !value ||
    typeof value !== 'object' ||
    !('homePath' in value) ||
    !('incarnationId' in value)
  ) {
    return undefined
  }
  return typeof value.homePath === 'string' &&
    isAbsolute(value.homePath) &&
    isPtyIncarnationId(value.incarnationId)
    ? { homePath: value.homePath, incarnationId: value.incarnationId }
    : undefined
}

export function parseRegistry(parsed: unknown): CodexPaneAccountRegistryFile {
  const registry: CodexPaneAccountRegistryFile = { version: 2, panes: {} }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('panes' in parsed) ||
    !parsed.panes ||
    typeof parsed.panes !== 'object' ||
    Array.isArray(parsed.panes)
  ) {
    return registry
  }
  if ('legacyWslAttributionUnknown' in parsed && parsed.legacyWslAttributionUnknown === true) {
    registry.legacyWslAttributionUnknown = true
  }
  for (const [id, value] of Object.entries(parsed.panes)) {
    if (!isPaneAccountRecord(value)) {
      continue
    }
    const launchProvenance = readLaunchProvenance(value.launchProvenance)
    const route = value.homeRoute
    const homeRoute =
      route === 'real-home' ||
      route === 'shared-home' ||
      route === 'account-home' ||
      route === 'wsl-home'
        ? route
        : String(route) === 'custom-home'
          ? 'shared-home'
          : undefined
    registry.panes[id] = {
      accountId: value.accountId,
      ...(value.selectionKey ? { selectionKey: value.selectionKey } : {}),
      ...(homeRoute ? { homeRoute } : {}),
      ...(launchProvenance ? { launchProvenance } : {})
    }
  }
  return registry
}
