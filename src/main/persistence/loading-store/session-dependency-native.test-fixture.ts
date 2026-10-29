import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import {
  SESSION_MAP_FIELDS,
  type SessionMapField,
  type SessionUnitChange
} from '../../../shared/session-change-set'
import type { SessionReferenceKind, SessionUnitAddress } from '../../../shared/session-unit-index'
import { WORKSPACE_SESSION_FIELD_OWNERSHIP } from '../../../shared/workspace-session-host-field-ownership'
import { normalizeWorkspaceSessionKeyToWorkspaceId } from '../../../shared/workspace-scope'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import { isWorkspaceSessionRecord } from '../../../shared/workspace-session-host-records'

export function nativeSessionReferences(
  root: WorkspaceSessionState,
  field: SessionMapField,
  key: string
) {
  const refs = new Map<SessionReferenceKind, Set<string>>()
  if (!Object.hasOwn(root[field] ?? {}, key)) {
    return refs
  }
  const value: unknown = root[field]?.[key]
  const add = (kind: SessionReferenceKind, id: unknown) => {
    if (typeof id !== 'string' || !id) {
      return
    }
    const ids = refs.get(kind) ?? new Set<string>()
    ids.add(id)
    refs.set(kind, ids)
  }
  const owner = (id: unknown) => {
    if (typeof id !== 'string') {
      return
    }
    add('owner', id)
    const raw = normalizeWorkspaceSessionKeyToWorkspaceId(id)
    add('owner', raw)
    add('repo', getRepoIdFromWorktreeId(raw))
    add('repo', getRepoIdFromWorktreeId(id.includes('|') ? id.slice(id.indexOf('|') + 1) : id))
  }
  const policy = WORKSPACE_SESSION_FIELD_OWNERSHIP[field]
  if (policy === 'worktreeKeyed') {
    owner(key)
  }
  if (policy === 'tabKeyed') {
    add('tab', key)
  }
  if (policy === 'fileKeyed') {
    add('file', key)
  }
  if (policy === 'browserWorkspaceKeyed') {
    add('browser', key)
  }
  if (
    policy === 'paneKeyed' ||
    policy === 'sleepingAgentKeyed' ||
    policy === 'surfaceTombstoneKeyed'
  ) {
    add('pane', key)
    if (key.includes(':')) {
      add('tab', key.slice(0, key.indexOf(':')))
    }
    // Legacy keys retain their tab reference, but only UUID pane identities name leaves.
    const leaf = key.slice(key.lastIndexOf(':') + 1)
    if (/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(leaf)) {
      add('leaf', leaf)
    }
  }
  if (field === 'terminalTopologyRevisionByRepoId') {
    add('repo', key)
  }
  if (field === 'remoteSessionIdsByTabId') {
    add('pty', value)
  }
  const rows: unknown[] = Array.isArray(value) ? value : [value]
  for (const row of rows) {
    if (!isWorkspaceSessionRecord(row)) {
      continue
    }
    owner(row.worktreeId)
    if (field === 'tabsByWorktree' || field === 'unifiedTabs') {
      add('tab', row.id)
      if (row.contentType === 'terminal') {
        add('tab', row.entityId)
      }
      add('pty', row.ptyId)
    } else if (field === 'openFilesByWorktree') {
      owner(isWorkspaceSessionRecord(row.docLocation) ? row.docLocation.worktreeId : undefined)
      add('file', row.id)
      add('file', row.filePath)
    } else if (field === 'browserTabsByWorktree' || field === 'browserPagesByWorkspace') {
      owner(isWorkspaceSessionRecord(row.docLocation) ? row.docLocation.worktreeId : undefined)
      add(field === 'browserTabsByWorktree' ? 'browser' : 'page', row.id)
    } else if (field === 'terminalLayoutsByTabId') {
      const visit = (node: unknown) => {
        if (!isWorkspaceSessionRecord(node)) {
          return
        }
        if (node.type === 'leaf') {
          add('leaf', node.leafId)
          if (typeof node.leafId === 'string') {
            add('pane', `${key}:${node.leafId}`)
          }
        } else if (node.type === 'split') {
          visit(node.first)
          visit(node.second)
        }
      }
      visit(row.root)
      for (const id of Object.values(
        isWorkspaceSessionRecord(row.ptyIdsByLeafId) ? row.ptyIdsByLeafId : {}
      )) {
        add('pty', id)
      }
      for (const id of Object.values(
        isWorkspaceSessionRecord(row.scrollbackRefsByLeafId) ? row.scrollbackRefsByLeafId : {}
      )) {
        add('scrollback', id)
      }
    } else {
      add('tab', row.parentTabId ?? row.tabId)
      add('pane', row.paneKey)
      add('leaf', row.leafId)
      add('pty', row.ptyId)
    }
  }
  return refs
}

export function nativeAffectedOwners(
  prior: WorkspaceSessionState,
  next: WorkspaceSessionState,
  changes: readonly SessionUnitChange[]
) {
  const entries = [prior, next].flatMap((root) =>
    SESSION_MAP_FIELDS.flatMap((field) =>
      Object.keys(root[field] ?? {}).map((key) => ({
        field,
        key,
        refs: nativeSessionReferences(root, field, key)
      }))
    )
  )
  const queue: SessionUnitAddress[] = changes.flatMap((unit) =>
    unit.key === null ? [] : [{ field: unit.field, key: unit.key }]
  )
  const seen = new Set<string>(),
    owners = new Set<string>()
  for (let i = 0; i < queue.length; i++) {
    const unit = queue[i],
      id = JSON.stringify([unit.field, unit.key])
    if (seen.has(id)) {
      continue
    }
    seen.add(id)
    for (const root of [prior, next]) {
      const refs = nativeSessionReferences(root, unit.field, unit.key)
      for (const owner of refs.get('owner') ?? []) {
        owners.add(owner)
      }
      for (const [kind, ids] of refs) {
        if (
          kind === 'scrollback' ||
          (kind === 'repo' &&
            !changes.some((change) => change.field === 'terminalTopologyRevisionByRepoId'))
        ) {
          continue
        }
        for (const entry of entries) {
          if ([...ids].some((name) => entry.refs.get(kind)?.has(name))) {
            queue.push(entry)
          }
        }
      }
    }
  }
  return owners
}
