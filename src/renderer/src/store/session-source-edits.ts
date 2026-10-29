import type { OpenFile } from './slices/editor/types/open-file'
import type { SessionSourceDiscovery, SessionSourceField } from '../lib/session-source-fields'

export const SESSION_SOURCE_RECEIPT = Symbol('session source receipt')
declare const SOURCE_SNAPSHOT: unique symbol
export type SessionSourceSnapshot<S> = S & { readonly [SOURCE_SNAPSHOT]: true }
type CatalogField = 'repos' | 'folderWorkspaces' | 'projectGroups'
type SourceEntry = { present: boolean; value: unknown }
type CatalogKey<S> = Extract<SourceKey<S>, CatalogField>
type CatalogRow<S, F extends CatalogKey<S>> = S[F] extends readonly (infer V)[] ? V : never
type SourceKey<S> = Extract<keyof S, SessionSourceField>
type RecordKey<S> = {
  [F in SourceKey<S>]: NonNullable<S[F]> extends readonly unknown[]
    ? never
    : NonNullable<S[F]> extends ReadonlyMap<string, unknown> | Record<string, unknown>
      ? F
      : never
}[SourceKey<S>]
type Entry<S, F extends RecordKey<S>> =
  NonNullable<S[F]> extends ReadonlyMap<string, infer V>
    ? V
    : NonNullable<S[F]> extends Record<string, infer V>
      ? V
      : never
export type OrdinarySourcePartial<S> = Partial<Omit<S, SourceKey<S>>> &
  Partial<Record<SourceKey<S>, never>>
export type SessionSourceWrite<S> = Partial<S> & {
  readonly [SESSION_SOURCE_RECEIPT]: SessionSourceDiscovery
}
export type SessionSourceUpdate<S> =
  | OrdinarySourcePartial<S>
  | SessionSourceWrite<S>
  | ((
      state: SessionSourceSnapshot<S>
    ) => OrdinarySourcePartial<S> | SessionSourceWrite<S> | SessionSourceSnapshot<S>)
export type SessionSourceSetArgs<S> =
  | [partial: SessionSourceUpdate<S>, replace?: false]
  | [partial: SessionSourceWrite<S> & S, replace: true]
export type SessionSourceSet<S> = {
  (partial: SessionSourceUpdate<S>, replace?: false): void
  (partial: SessionSourceWrite<S> & S, replace: true): void
}

/** Values and addresses are emitted by the same operation; no source ancestry is retained. */
export class SessionSourceEdit<S extends object> {
  private readonly partial: Partial<S> = {}
  private readonly changes = new Map<SessionSourceField, Set<string> | null>()
  private readonly copied = new Set<SourceKey<S>>()
  private readonly baseEntries = new Map<SessionSourceField, Map<string, SourceEntry>>()
  private readonly fileRows = new Map<string, OpenFile[]>()
  private readonly fileOwners = new Set<string>()
  private full = false
  private filesByOwner?: Map<string, OpenFile[]>
  private readonly catalogRows = new Map<CatalogField, Map<string, unknown[]>>()
  private readonly catalogsChanged = new Map<CatalogField, Set<string>>()
  private readonly catalogsResult: NonNullable<SessionSourceDiscovery['catalogs']> = {}

  constructor(private readonly source: S) {}

  read<F extends SourceKey<S>>(field: F): Readonly<S[F]> {
    return Object.hasOwn(this.partial, field) ? this.partial[field]! : this.source[field]
  }

  private mark(field: SourceKey<S>, key: string): void {
    if (this.changes.get(field) === null) {
      return
    }
    const keys = this.changes.get(field) ?? new Set<string>()
    keys.add(key)
    this.changes.set(field, keys)
  }

  private current<F extends RecordKey<S>>(field: F) {
    // SAFETY: RecordKey admits only string-keyed Records and Maps, including optional ones.
    return (Object.hasOwn(this.partial, field) ? this.partial[field] : this.source[field]) as
      | ReadonlyMap<string, unknown>
      | Readonly<Record<string, unknown>>
      | undefined
  }

  private baseEntry<F extends RecordKey<S>>(field: F, key: string) {
    const entries = this.baseEntries.get(field) ?? new Map<string, SourceEntry>()
    this.baseEntries.set(field, entries)
    let entry = entries.get(key)
    if (!entry) {
      const source = this.source[field]
      entry = {
        present: source instanceof Map ? source.has(key) : Object.hasOwn(source ?? {}, key),
        value: source instanceof Map ? source.get(key) : Reflect.get(source ?? {}, key)
      }
      entries.set(key, entry)
    }
    return entry
  }

  entry<F extends RecordKey<S>>(field: F, key: string): Entry<S, F> | undefined {
    const current = this.current(field)
    const value = Object.hasOwn(this.partial, field)
      ? current instanceof Map
        ? current.get(key)
        : Reflect.get(current ?? {}, key)
      : this.baseEntry(field, key).value
    // SAFETY: the field/key pair admits only that Record or Map's entry type.
    return value as Entry<S, F> | undefined
  }

  private record<F extends RecordKey<S>>(field: F): Map<string, unknown> | Record<string, unknown> {
    if (!this.copied.has(field)) {
      const source = this.current(field)
      Object.assign(this.partial, {
        [field]: source instanceof Map ? new Map(source) : { ...source }
      })
      this.copied.add(field)
    }
    // SAFETY: record fields are copied above as a Map or plain Record and never replaced here.
    return this.partial[field] as Map<string, unknown> | Record<string, unknown>
  }

  set<F extends RecordKey<S>>(field: F, key: string, value: Entry<S, F>): this {
    const current = this.current(field)
    const base = this.baseEntry(field, key)
    const edited = Object.hasOwn(this.partial, field)
    const present = edited
      ? current instanceof Map
        ? current.has(key)
        : Object.hasOwn(current ?? {}, key)
      : base.present
    const prior = edited
      ? current instanceof Map
        ? current.get(key)
        : Reflect.get(current ?? {}, key)
      : base.value
    if (present && prior === value) {
      return this
    }
    const source = this.source[field]
    if (
      !present &&
      this.changes.get(field)?.has(key) &&
      (source instanceof Map ? source.has(key) : Object.hasOwn(source ?? {}, key))
    ) {
      this.full = true
      this.changes.set(field, null)
    }
    const record = this.record(field)
    if (record instanceof Map) {
      record.set(key, value)
    } else {
      Object.defineProperty(record, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true
      })
    }
    this.mark(field, key)
    return this
  }

  remove<F extends RecordKey<S>>(field: F, key: string): this {
    this.baseEntry(field, key)
    const current = this.current(field)
    if (!(current instanceof Map ? current.has(key) : Object.hasOwn(current ?? {}, key))) {
      return this
    }
    const record = this.record(field)
    if (record instanceof Map) {
      record.delete(key)
    } else {
      Reflect.deleteProperty(record, key)
    }
    this.mark(field, key)
    return this
  }

  scalar<F extends Exclude<SourceKey<S>, RecordKey<S> | 'openFiles' | CatalogField>>(
    field: F,
    value: S[F]
  ): this {
    const current = Object.hasOwn(this.partial, field) ? this.partial : this.source
    if (current[field] !== value || !Object.hasOwn(current, field)) {
      Object.assign(this.partial, { [field]: value })
      this.changes.set(field, null)
    }
    return this
  }

  replace<F extends SourceKey<S>>(field: F, value: S[F]): this {
    Object.assign(this.partial, { [field]: value })
    this.copied.delete(field)
    this.changes.set(field, null)
    this.full = true
    return this
  }

  file(before: OpenFile | undefined, after: OpenFile): OpenFile
  file(before: OpenFile | undefined, after: undefined): undefined
  file(before: OpenFile | undefined, after: OpenFile | undefined): OpenFile | undefined
  file(before: OpenFile | undefined, after: OpenFile | undefined): OpenFile | undefined {
    if (before !== after) {
      if (before) {
        this.fileOwners.add(before.worktreeId)
      }
      if (after) {
        this.fileOwners.add(after.worktreeId)
      }
    }
    if (after) {
      const rows = this.fileRows.get(after.worktreeId) ?? []
      rows.push(after)
      this.fileRows.set(after.worktreeId, rows)
    }
    return after
  }

  files(files: OpenFile[]): this {
    Object.assign(this.partial, { openFiles: files })
    this.filesByOwner = new Map(
      [...this.fileOwners].map((owner) => [owner, this.fileRows.get(owner) ?? []])
    )
    this.changes.set('openFiles', new Set(this.fileOwners))
    this.fileOwners.clear()
    this.fileRows.clear()
    return this
  }

  catalog<F extends CatalogKey<S>>(
    field: F,
    before: CatalogRow<S, F> | undefined,
    after: CatalogRow<S, F> | undefined
  ): void {
    // SAFETY: the three catalog fields are arrays of entities with string IDs.
    const prior = before as { id: string } | undefined
    // SAFETY: the same catalog domain applies to its candidate row.
    const next = after as { id: string } | undefined
    const changed = this.catalogsChanged.get(field) ?? new Set<string>()
    if (before !== after) {
      if (prior) {
        changed.add(prior.id)
      }
      if (next) {
        changed.add(next.id)
      }
    }
    this.catalogsChanged.set(field, changed)
    if (next) {
      const rows = this.catalogRows.get(field) ?? new Map<string, unknown[]>()
      const entries = rows.get(next.id) ?? []
      entries.push(after)
      rows.set(next.id, entries)
      this.catalogRows.set(field, rows)
    }
  }

  catalogs<F extends CatalogKey<S>>(field: F, rows: S[F]): this {
    Object.assign(this.partial, { [field]: rows })
    const changed = this.catalogsChanged.get(field) ?? new Set<string>()
    this.changes.set(field, new Set(changed))
    Object.assign(this.catalogsResult, {
      [field]: new Map([...changed].map((id) => [id, this.catalogRows.get(field)?.get(id) ?? []]))
    })
    this.catalogRows.delete(field)
    this.catalogsChanged.delete(field)
    return this
  }

  finish(other: OrdinarySourcePartial<S> = {}): SessionSourceWrite<S> {
    this.copied.clear()
    for (const [field, keys] of this.changes) {
      if (
        !keys ||
        field === 'openFiles' ||
        field === 'repos' ||
        field === 'folderWorkspaces' ||
        field === 'projectGroups'
      ) {
        continue
      }
      const after = Reflect.get(this.partial, field)
      for (const key of keys) {
        // SAFETY: set/remove capture the base entry before admitting a keyed edit.
        const base = this.baseEntries.get(field)?.get(key) as SourceEntry
        const oldPresent = base.present
        const nextPresent = after instanceof Map ? after.has(key) : Object.hasOwn(after ?? {}, key)
        const oldValue = base.value
        const nextValue = after instanceof Map ? after.get(key) : Reflect.get(after ?? {}, key)
        if (oldPresent === nextPresent && oldValue === nextValue) {
          keys.delete(key)
        }
      }
    }
    return Object.assign({}, other, this.partial, {
      [SESSION_SOURCE_RECEIPT]: {
        changes: new Map(
          [...this.changes].map(([field, keys]) => [field, keys === null ? null : new Set(keys)])
        ),
        full: this.full,
        catalogs: { ...this.catalogsResult },
        filesByOwner:
          this.filesByOwner &&
          new Map([...this.filesByOwner].map(([owner, rows]) => [owner, [...rows]]))
      }
    })
  }
}

export function editSessionSource<S extends object>(state: S): SessionSourceEdit<S> {
  return new SessionSourceEdit(state)
}
