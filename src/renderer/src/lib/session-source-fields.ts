import type { AppState } from '../store/types'
import type { OpenFile } from '../store/slices/editor'
import { SESSION_RELEVANT_FIELDS } from './workspace-session'

export const SESSION_ROUTING_FIELDS = [
  'folderWorkspaces',
  'projectGroups',
  'restoredRuntimeHostIdByWorkspaceSessionKey',
  'hydratedRuntimeSessionHostIds',
  'contestedPrimaryHostBySessionKey',
  'contestedHostWorkspaceSessions'
] as const satisfies readonly (keyof AppState)[]
export const SESSION_SOURCE_FIELDS = [
  ...SESSION_RELEVANT_FIELDS,
  ...SESSION_ROUTING_FIELDS
] as const
export type SessionSourceField = (typeof SESSION_SOURCE_FIELDS)[number]
export type SessionMutation = ReadonlyMap<SessionSourceField, ReadonlySet<string> | null>
export type SessionSourceDiscovery = {
  changes: SessionMutation
  full: boolean
  filesByOwner?: ReadonlyMap<string, OpenFile[]>
  catalogs?: {
    repos?: Map<string, AppState['repos']>
    folderWorkspaces?: Map<string, AppState['folderWorkspaces']>
    projectGroups?: Map<string, AppState['projectGroups']>
  }
}

export function groupSessionFiles(
  files: readonly OpenFile[],
  owners?: ReadonlySet<string>
): Map<string, OpenFile[]> {
  const groups = new Map<string, OpenFile[]>()
  for (const file of files) {
    if (owners && !owners.has(file.worktreeId)) {
      continue
    }
    const rows = groups.get(file.worktreeId)
    if (rows) {
      rows.push(file)
    } else {
      groups.set(file.worktreeId, [file])
    }
  }
  return groups
}

export function groupSessionCatalog<T extends { id: string }>(
  rows: readonly T[]
): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const row of rows) {
    const entries = groups.get(row.id)
    if (entries) {
      entries.push(row)
    } else {
      groups.set(row.id, [row])
    }
  }
  return groups
}
