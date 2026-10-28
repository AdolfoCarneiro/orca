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

function sourceKeys(value: object): string[] {
  return value instanceof Map ? [...value.keys()] : Object.keys(value)
}
function sourceHas(value: object, key: string): boolean {
  return value instanceof Map ? value.has(key) : Object.hasOwn(value, key)
}
function sourceValue(value: object, key: string): unknown {
  return value instanceof Map ? value.get(key) : Reflect.get(value, key)
}
function isIntegerProperty(key: string): boolean {
  const numeric = Number(key)
  return (
    Number.isInteger(numeric) && numeric >= 0 && numeric < 4_294_967_295 && String(numeric) === key
  )
}

function compareRecordSources(
  before: object,
  after: object
): { keys: Set<string>; reordered: boolean } {
  const oldKeys = Object.keys(before),
    newKeys = Object.keys(after)
  // SAFETY: this branch handles own string-keyed Records, after excluding Maps/arrays/Sets.
  const prior = before as Readonly<Record<string, unknown>>
  // SAFETY: the same checked source domain applies to the candidate.
  const candidate = after as Readonly<Record<string, unknown>>
  const keys = new Set<string>()
  if (oldKeys.length === newKeys.length) {
    let aligned = true
    for (let i = 0; i < oldKeys.length; i++) {
      const key = oldKeys[i]
      if (key !== newKeys[i]) {
        aligned = false
        break
      }
      if (prior[key] !== candidate[key]) {
        keys.add(key)
      }
    }
    if (aligned) {
      return { keys, reordered: false }
    }
    keys.clear()
  }
  let oldStrings = 0,
    nextString = 0
  while (oldStrings < oldKeys.length && isIntegerProperty(oldKeys[oldStrings])) {
    oldStrings++
  }
  while (nextString < newKeys.length && isIntegerProperty(newKeys[nextString])) {
    nextString++
  }
  const firstNewString = nextString
  let reordered = false
  for (let i = 0; i < oldKeys.length; i++) {
    const key = oldKeys[i]
    const present = key === newKeys[i] || Object.hasOwn(after, key)
    if (!present || candidate[key] !== prior[key]) {
      keys.add(key)
    }
    if (present && i >= oldStrings && key !== newKeys[nextString++]) {
      reordered = true
    }
  }
  for (let i = 0; i < newKeys.length; i++) {
    const key = newKeys[i]
    if (key !== oldKeys[i] && !Object.hasOwn(before, key)) {
      keys.add(key)
      if (i >= firstNewString && key !== newKeys[nextString++]) {
        reordered = true
      }
    }
  }
  return { keys, reordered }
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

/** Discovery compares source identities once per flush; ACKs have a separate baseline. */
export function discoverSessionSources(
  previous: AppState,
  next: AppState,
  fields: Iterable<SessionSourceField> = SESSION_SOURCE_FIELDS
): SessionSourceDiscovery {
  const changes = new Map<SessionSourceField, ReadonlySet<string> | null>()
  let full = false
  let filesByOwner: Map<string, OpenFile[]> | undefined
  const catalogs: NonNullable<SessionSourceDiscovery['catalogs']> = {}
  for (const field of fields) {
    const before = previous[field],
      after = next[field]
    if (before === after) {
      continue
    }
    if (field === 'openFiles') {
      const prior = groupSessionFiles(previous.openFiles)
      filesByOwner = groupSessionFiles(next.openFiles)
      const owners = new Set<string>()
      for (const [owner, rows] of prior) {
        const current = filesByOwner.get(owner)
        if (
          !current ||
          rows.length !== current.length ||
          rows.some((row, i) => row !== current[i])
        ) {
          owners.add(owner)
        }
      }
      for (const owner of filesByOwner.keys()) {
        if (!prior.has(owner)) {
          owners.add(owner)
        }
      }
      changes.set(field, owners)
    } else if (field === 'repos' || field === 'folderWorkspaces' || field === 'projectGroups') {
      const discover = <T extends { id: string }>(oldRows: readonly T[], newRows: readonly T[]) => {
        const prior = groupSessionCatalog(oldRows),
          current = groupSessionCatalog(newRows)
        const keys = new Set<string>()
        for (const [id, rows] of prior) {
          const entries = current.get(id)
          if (
            !entries ||
            entries.length !== rows.length ||
            rows.some((row, i) => row !== entries[i])
          ) {
            keys.add(id)
          }
        }
        for (const id of current.keys()) {
          if (!prior.has(id)) {
            keys.add(id)
          }
        }
        const applied = [...prior.keys()].filter((id) => current.has(id))
        for (const id of current.keys()) {
          if (!prior.has(id)) {
            applied.push(id)
          }
        }
        const ordered = [...current.keys()]
        if (applied.some((id, i) => id !== ordered[i])) {
          full = true
        }
        changes.set(field, keys)
        return current
      }
      if (field === 'repos') {
        catalogs.repos = discover(previous.repos, next.repos)
      } else if (field === 'folderWorkspaces') {
        catalogs.folderWorkspaces = discover(previous.folderWorkspaces, next.folderWorkspaces)
      } else {
        catalogs.projectGroups = discover(previous.projectGroups, next.projectGroups)
      }
    } else if (
      !before ||
      !after ||
      typeof before !== 'object' ||
      typeof after !== 'object' ||
      Array.isArray(before) ||
      Array.isArray(after) ||
      before instanceof Set ||
      after instanceof Set
    ) {
      changes.set(field, null)
    } else if (!(before instanceof Map) && !(after instanceof Map)) {
      const comparison = compareRecordSources(before, after)
      changes.set(field, comparison.keys)
      full ||= comparison.reordered
    } else {
      const oldKeys = sourceKeys(before),
        newKeys = sourceKeys(after)
      const keys = new Set<string>()
      for (const key of oldKeys) {
        if (!sourceHas(after, key) || sourceValue(after, key) !== sourceValue(before, key)) {
          keys.add(key)
        }
      }
      for (const key of newKeys) {
        if (!sourceHas(before, key)) {
          keys.add(key)
        }
      }
      const appliedOrder = oldKeys.filter((key) => sourceHas(after, key))
      for (const key of newKeys) {
        if (!sourceHas(before, key)) {
          appliedOrder.push(key)
        }
      }
      // Integer Record properties sort automatically; Map keys retain insertion order.
      const ordered =
        after instanceof Map ? newKeys : newKeys.filter((key) => !isIntegerProperty(key))
      const applied =
        after instanceof Map ? appliedOrder : appliedOrder.filter((key) => !isIntegerProperty(key))
      if (applied.some((key, i) => key !== ordered[i])) {
        full = true
      }
      changes.set(field, keys)
    }
  }
  return { changes, full, filesByOwner, catalogs }
}
