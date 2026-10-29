import type { AppState } from '../store/types'
import {
  SESSION_SOURCE_KINDS,
  type SessionSourceDiscovery,
  type SessionSourceField,
  type SessionSourcePresence,
  type SessionSourceSequences
} from './session-source-fields'

/** Source coalescing is independent of delivery ACKs; deletion history retains native order. */
export class SessionSourceReceipts {
  private readonly changes = new Map<SessionSourceField, Set<string> | null>()
  private readonly sequences: SessionSourceSequences = {}
  private readonly presence = new Map<SessionSourceField, Map<string, SessionSourcePresence>>()
  private full = false

  get size(): number {
    return this.changes.size
  }

  add(receipt: SessionSourceDiscovery): void {
    this.full ||= receipt.full
    for (const [field, entries] of receipt.presence ?? []) {
      const pending = this.presence.get(field) ?? new Map<string, SessionSourcePresence>()
      this.presence.set(field, pending)
      for (const [key, transition] of entries) {
        const prior = pending.get(key)
        if (prior && !prior.after && transition.after) {
          this.full = true
        }
        pending.set(key, { before: prior?.before ?? transition.before, after: transition.after })
      }
    }
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
    for (const field of Object.keys(receipt.sequences ?? {})) {
      // SAFETY: sequence properties are restricted to the exhaustive sequence field domain.
      const incoming = Reflect.get(receipt.sequences!, field) as ReadonlyMap<string, unknown[]>
      const pending = Reflect.get(this.sequences, field) ?? new Map<string, unknown[]>()
      for (const [key, rows] of incoming ?? []) {
        pending.set(key, rows)
      }
      Reflect.set(this.sequences, field, pending)
    }
  }

  snapshot(): SessionSourceDiscovery {
    return {
      changes: new Map([...this.changes].map(([field, keys]) => [field, keys && new Set(keys)])),
      full: this.full,
      sequences: Object.fromEntries(
        Object.entries(this.sequences).map(([field, rows]) => [field, new Map(rows)])
      ),
      presence: new Map([...this.presence].map(([field, entries]) => [field, new Map(entries)]))
    }
  }

  take(before: AppState, after: AppState): SessionSourceDiscovery {
    const receipt = this.snapshot()
    const changes = new Map<SessionSourceField, ReadonlySet<string> | null>()
    for (const [field, selected] of receipt.changes) {
      const prior = before[field],
        next = after[field]
      if (prior === next && Object.hasOwn(before, field) === Object.hasOwn(after, field)) {
        continue
      }
      if (!selected || SESSION_SOURCE_KINDS[field] !== 'keyed') {
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
    return { ...receipt, changes }
  }
}
