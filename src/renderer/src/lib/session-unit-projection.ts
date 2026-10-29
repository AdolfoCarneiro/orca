import type { AppState } from '../store/types'
import { SESSION_RELEVANT_FIELDS, type WorkspaceSessionSnapshot } from './workspace-session'
import { buildWorkspaceSessionPatch } from './workspace-session-patch'
import {
  SESSION_MAP_FIELDS,
  sessionMap,
  type SessionMapField
} from '../../../shared/session-change-set'
import type { SessionUnitAddress } from '../../../shared/session-unit-index'

import { groupSessionFiles, type SessionSourceDiscovery } from './session-source-discovery'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import { SESSION_ROUTING_FIELDS } from './session-source-discovery'

import {
  SessionProjectionIndex,
  SOURCE_MAPS,
  RECONNECT_FIELDS,
  type SessionProjectionUpdate
} from './session-projection-index'
export type { SessionProjectionUpdate } from './session-projection-index'
export class SessionUnitProjection extends SessionProjectionIndex {
  update(state: AppState, discovery: SessionSourceDiscovery): SessionProjectionUpdate {
    const mutation = discovery.changes
    // Unkeyed source or routing replacements are explicit compatibility boundaries.
    if (
      discovery.full ||
      mutation.has('contestedHostWorkspaceSessions') ||
      [...mutation].some(
        ([field, keys]) =>
          (keys === null && SESSION_ROUTING_FIELDS.some((candidate) => candidate === field)) ||
          (keys === null && (Object.hasOwn(SOURCE_MAPS, field) || field === 'openFiles'))
      )
    ) {
      const rebuilt = new SessionUnitProjection(state)
      this.index = rebuilt.index
      this.catalog = rebuilt.catalog
      this.remoteConnectionByTab.clear()
      this.remoteConnectionCounts.clear()
      for (const [id, value] of rebuilt.remoteConnectionByTab) {
        this.remoteConnectionByTab.set(id, value)
      }
      for (const [id, value] of rebuilt.remoteConnectionCounts) {
        this.remoteConnectionCounts.set(id, value)
      }
      return this.full(state)
    }
    const queue: SessionUnitAddress[] = []
    const owners = new Set<string>()
    const tabIds = new Set<string>()
    const changed = new Set<keyof WorkspaceSessionSnapshot>()
    const routedOwners = this.catalog.update(state, discovery)
    for (const owner of routedOwners) {
      owners.add(owner)
      queue.push(...this.index.references('owner', owner))
    }
    for (const repo of mutation.get('repos') ?? []) {
      queue.push(...this.index.references('repo', repo))
    }
    if (routedOwners.size || mutation.has('repos') || mutation.has('worktreesByRepo')) {
      for (const source of Object.keys(SOURCE_MAPS)) {
        // SAFETY: SOURCE_MAPS only names persisted snapshot inputs.
        changed.add(source as keyof WorkspaceSessionSnapshot)
      }
    }
    for (const [source, keys] of mutation) {
      if (SESSION_RELEVANT_FIELDS.some((field) => field === source)) {
        // SAFETY: membership in the exhaustive source-field list establishes the snapshot key.
        changed.add(source as keyof WorkspaceSessionSnapshot)
      }
      const field = Object.entries(SOURCE_MAPS).find(([name]) => name === source)?.[1]
      if (field) {
        for (const key of keys ?? []) {
          queue.push({ field, key })
          for (const owner of this.index.ids(field, key, 'owner')) {
            owners.add(owner)
          }
          for (const kind of ['tab', 'file', 'page', 'browser', 'pane'] as const) {
            for (const id of this.index.ids(field, key, kind)) {
              if (kind === 'tab') {
                tabIds.add(id)
              }
              queue.push(...this.index.references(kind, id))
            }
          }
          this.index.replace(field, key, Reflect.get(state, source)?.[key])
        }
      }
      if (source === 'openFiles') {
        for (const owner of keys ?? []) {
          for (const id of this.index.ids('openFilesByWorktree', owner, 'file')) {
            queue.push(...this.index.references('file', id))
          }
          const files = discovery.filesByOwner?.get(owner)
          this.index.replace('openFilesByWorktree', owner, files)
          owners.add(owner)
          queue.push({ field: 'openFilesByWorktree', key: owner })
        }
      }
      if (source === 'editorDrafts') {
        for (const id of keys ?? []) {
          for (const address of this.index.references('file', id)) {
            if (address.field === 'openFilesByWorktree') {
              owners.add(address.key)
            }
          }
        }
      }
      if (RECONNECT_FIELDS.has(source)) {
        for (const id of keys ?? []) {
          tabIds.add(id)
          queue.push(...this.index.references('tab', id))
        }
      }
      if (source === 'remoteBrowserPageHandlesByPageId') {
        for (const id of keys ?? []) {
          queue.push(...this.index.references('page', id))
        }
      }
    }
    const scope = new Map<SessionMapField, Set<string>>()
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const address = queue[cursor]
      const keys = scope.get(address.field) ?? new Set<string>()
      if (keys.has(address.key)) {
        continue
      }
      keys.add(address.key)
      scope.set(address.field, keys)
      for (const index of [this.index]) {
        for (const kind of ['owner', 'tab', 'file', 'page', 'browser', 'pane'] as const) {
          for (const id of index.ids(address.field, address.key, kind)) {
            if (kind === 'owner') {
              owners.add(id)
            }
            if (kind === 'tab') {
              tabIds.add(id)
            }
            queue.push(...index.references(kind, id))
          }
        }
      }
    }
    for (const owner of owners) {
      for (const address of this.index.references('owner', owner)) {
        const keys = scope.get(address.field) ?? new Set<string>()
        keys.add(address.key)
        scope.set(address.field, keys)
      }
    }
    const editorChanged = (
      [
        'openFiles',
        'editorDrafts',
        'markdownFrontmatterVisible',
        'activeFileIdByWorktree',
        'activeTabTypeByWorktree'
      ] as const
    ).some((field) => changed.has(field))
    const selectedFiles = editorChanged
      ? (discovery.filesByOwner ?? groupSessionFiles(state.openFiles, owners))
      : undefined
    const sparse = {
      ...state,
      openFiles: [...owners].flatMap((id) => selectedFiles?.get(id) ?? []),
      repos: this.catalog.repoRows([...owners].map(getRepoIdFromWorktreeId)),
      worktreesByRepo: {}
    } satisfies AppState
    for (const [source, field] of Object.entries(SOURCE_MAPS)) {
      Object.assign(sparse, {
        [source]: Object.fromEntries(
          [...(scope.get(field) ?? [])].flatMap((key) => {
            const value = Reflect.get(state, source)?.[key]
            return value === undefined ? [] : [[key, value]]
          })
        )
      })
    }
    for (const field of [
      'ptyIdsByTabId',
      'lastKnownRelayPtyIdByTabId',
      'pendingReconnectPtyIdByTabId',
      'deferredSshSessionIdsByTabId'
    ] as const) {
      Object.assign(sparse, {
        [field]: Object.fromEntries(
          [...tabIds].flatMap((id) =>
            state[field]?.[id] === undefined ? [] : [[id, state[field][id]]]
          )
        )
      })
    }
    Object.assign(sparse.worktreesByRepo, this.catalog.worktreeRows(owners))
    const connectionIds = new Set<string>(mutation.get('sshConnectionStates') ?? [])
    for (const id of tabIds) {
      const old = this.remoteConnectionByTab.get(id)
      if (old) {
        connectionIds.add(old)
      }
    }
    for (const repo of sparse.repos) {
      if (repo.connectionId) {
        connectionIds.add(repo.connectionId)
      }
    }
    sparse.sshConnectionStates = new Map(
      [...connectionIds].flatMap((id) => {
        const connection = state.sshConnectionStates.get(id)
        return connection ? [[id, connection] as const] : []
      })
    )
    const patch = buildWorkspaceSessionPatch(sparse, changed)
    const keys = new Map<SessionMapField, ReadonlySet<string>>()
    for (const field of SESSION_MAP_FIELDS) {
      if (patch[field] === undefined) {
        continue
      }
      keys.set(
        field,
        new Set([
          ...(scope.get(field) ?? []),
          ...([
            'terminalLayoutsByTabId',
            'localOnlyScrollbackByTabId',
            'remoteSessionIdsByTabId'
          ].includes(field)
            ? tabIds
            : []),
          ...Object.keys(sessionMap(patch, field) ?? {})
        ])
      )
    }
    const connections = new Map<string, boolean>()
    if (Object.hasOwn(patch, 'remoteSessionIdsByTabId')) {
      for (const id of tabIds) {
        this.replaceConnection(id, patch.remoteSessionIdsByTabId?.[id])
        const next = this.remoteConnectionByTab.get(id)
        if (next) {
          connectionIds.add(next)
        }
      }
    }
    if (Object.hasOwn(patch, 'activeConnectionIdsAtShutdown')) {
      for (const id of connectionIds) {
        const status = state.sshConnectionStates.get(id)?.status
        connections.set(
          id,
          status === 'connected' ||
            (Boolean(status && status !== 'disconnected' && status !== 'auth-failed') &&
              (this.remoteConnectionCounts.get(id) ?? 0) > 0)
        )
      }
    }
    // Reconnect membership is a per-owner contribution; its caller merges only these workspaces.
    return {
      patch,
      keys,
      terminalOwners: this.terminalOwners(keys),
      workspaces: owners,
      connections,
      full: false,
      routing: this.catalog.routing,
      routingChanged: routedOwners.size > 0
    }
  }
}
