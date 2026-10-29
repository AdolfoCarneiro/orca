import type { OpenFile } from './slices/editor/types/open-file'
import type { SessionSourceDiscovery, SessionSourceField } from '../lib/session-source-fields'
import {
  SESSION_SOURCE_RECEIPT,
  type OrdinarySourcePartial,
  type SessionSourceWrite
} from './session-source-edits'

/** Later middleware values win; receipts retain all selected addresses until projection consumes them. */
export function composeSessionSourceWrites<S>(
  ...writes: (SessionSourceWrite<S> | OrdinarySourcePartial<S>)[]
): SessionSourceWrite<S> {
  const changes = new Map<SessionSourceField, Set<string> | null>()
  let full = false
  const filesByOwner = new Map<string, OpenFile[]>()
  const catalogs: NonNullable<SessionSourceDiscovery['catalogs']> = {}
  for (const write of writes) {
    // SAFETY: only the private boundary symbol identifies a receipt; ordinary partials omit it.
    const receipt = Reflect.get(write, SESSION_SOURCE_RECEIPT) as SessionSourceDiscovery | undefined
    if (!receipt) {
      continue
    }
    full ||= receipt.full
    for (const [field, keys] of receipt.changes) {
      const prior = changes.get(field)
      changes.set(
        field,
        keys === null || prior === null ? null : new Set([...(prior ?? []), ...keys])
      )
    }
    for (const [owner, rows] of receipt.filesByOwner ?? []) {
      filesByOwner.set(owner, rows)
    }
    if (receipt.catalogs?.repos) {
      catalogs.repos = new Map([...(catalogs.repos ?? []), ...receipt.catalogs.repos])
    }
    if (receipt.catalogs?.folderWorkspaces) {
      catalogs.folderWorkspaces = new Map([
        ...(catalogs.folderWorkspaces ?? []),
        ...receipt.catalogs.folderWorkspaces
      ])
    }
    if (receipt.catalogs?.projectGroups) {
      catalogs.projectGroups = new Map([
        ...(catalogs.projectGroups ?? []),
        ...receipt.catalogs.projectGroups
      ])
    }
  }
  return Object.assign({}, ...writes, {
    [SESSION_SOURCE_RECEIPT]: { changes, full, filesByOwner, catalogs }
  })
}
