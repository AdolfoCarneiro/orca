import type { AppState } from '../store/types'
import type { OpenFile } from '../store/slices/editor'
import type { SessionSourceDiscovery, SessionSourceField } from './session-source-fields'

/** Pending source addresses share the subscriber lifetime, independent of delivery ACKs. */
export class SessionSourceReceipts {
  private readonly changes = new Map<SessionSourceField, Set<string> | null>()
  private readonly filesByOwner = new Map<string, OpenFile[]>()
  private readonly catalogs: NonNullable<SessionSourceDiscovery['catalogs']> = {}
  private full = false

  get size(): number {
    return this.changes.size
  }

  add(receipt: SessionSourceDiscovery): void {
    this.full ||= receipt.full
    for (const [field, keys] of receipt.changes) {
      const prior = this.changes.get(field)
      if (prior === null) {
        continue
      }
      if (keys === null) {
        this.changes.set(field, null)
      } else {
        const selected = prior ?? new Set<string>()
        for (const key of keys) {
          selected.add(key)
        }
        this.changes.set(field, selected)
      }
    }
    for (const [owner, rows] of receipt.filesByOwner ?? []) {
      this.filesByOwner.set(owner, rows)
    }
    if (receipt.catalogs?.repos) {
      this.catalogs.repos ??= new Map()
      for (const [id, rows] of receipt.catalogs.repos) {
        this.catalogs.repos.set(id, rows)
      }
    }
    if (receipt.catalogs?.folderWorkspaces) {
      this.catalogs.folderWorkspaces ??= new Map()
      for (const [id, rows] of receipt.catalogs.folderWorkspaces) {
        this.catalogs.folderWorkspaces.set(id, rows)
      }
    }
    if (receipt.catalogs?.projectGroups) {
      this.catalogs.projectGroups ??= new Map()
      for (const [id, rows] of receipt.catalogs.projectGroups) {
        this.catalogs.projectGroups.set(id, rows)
      }
    }
  }

  take(before: AppState, after: AppState): SessionSourceDiscovery {
    const changes = new Map<SessionSourceField, ReadonlySet<string> | null>()
    for (const [field, selected] of this.changes) {
      const prior = before[field],
        next = after[field]
      if (prior === next) {
        continue
      }
      if (
        !selected ||
        field === 'openFiles' ||
        field === 'repos' ||
        field === 'folderWorkspaces' ||
        field === 'projectGroups'
      ) {
        changes.set(field, selected)
        continue
      }
      const keys = new Set<string>()
      for (const key of selected) {
        const oldPresent = prior instanceof Map ? prior.has(key) : Object.hasOwn(prior ?? {}, key)
        const newPresent = next instanceof Map ? next.has(key) : Object.hasOwn(next ?? {}, key)
        const oldValue = prior instanceof Map ? prior.get(key) : Reflect.get(prior ?? {}, key)
        const newValue = next instanceof Map ? next.get(key) : Reflect.get(next ?? {}, key)
        if (oldPresent !== newPresent || oldValue !== newValue) {
          keys.add(key)
        }
      }
      changes.set(field, keys)
    }
    return { changes, full: this.full, filesByOwner: this.filesByOwner, catalogs: this.catalogs }
  }
}
