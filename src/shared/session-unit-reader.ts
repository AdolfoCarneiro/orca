export { type SessionUnitSelection, selectSessionUnits } from './session-unit-selection'

import type { WorkspaceSessionState } from './workspace-session-state-types'
import type {
  SessionUnitIndex,
  SessionReferenceKind,
  SessionUnitAddress
} from './session-unit-index'
import {
  SESSION_MAP_FIELDS,
  isSessionMapField,
  type SessionAdmissionKind,
  type SessionUnitChange,
  type SessionMapField
} from './session-change-set'
import {
  type SessionUnitView,
  type SessionEntry,
  type PreparedSession,
  isSessionUnitView
} from './session-reader-types'
export type {
  SessionUnitView,
  SessionPresence,
  SessionEntry,
  SessionScalarField,
  SessionPolicyField,
  PreparedSession
} from './session-reader-types'
import { SessionFieldReader } from './session-reader-fields'
export { isSessionUnitView } from './session-reader-types'

export class SessionUnitReader extends SessionFieldReader {
  static between(
    prior: WorkspaceSessionState,
    candidate: WorkspaceSessionState,
    index: SessionUnitIndex
  ): SessionUnitReader {
    const reader = new SessionUnitReader(prior, index)
    for (const field of new Set([...Object.keys(prior), ...Object.keys(candidate)])) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: both enumerated roots are session DTOs.
      const key = field as keyof WorkspaceSessionState
      if (
        prior[key] === candidate[key] &&
        Object.hasOwn(prior, key) === Object.hasOwn(candidate, key)
      ) {
        continue
      }
      reader.replace(
        key,
        Object.hasOwn(candidate, key)
          ? { present: true, value: candidate[key] }
          : { present: false, value: undefined }
      )
    }
    reader.incoming = { root: candidate, revision: reader.revision }
    return reader
  }

  view(phase: 'prior' | 'candidate'): SessionUnitView {
    if (phase === 'candidate') {
      return this
    }
    return {
      index: this.index,
      unit: (field, key) => this.unit(field, key, 'prior'),
      field: (field) => this.field(field, 'prior'),
      hasField: (field) => Object.hasOwn(this.prior, field),
      map: (field, keys) => {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every selected entry comes from this same typed map in the captured root.
        return Object.fromEntries(
          this.index
            .ordered(field, keys)
            .filter((key) => Object.hasOwn(this.prior[field] ?? {}, key))
            .map((key) => [key, this.prior[field]?.[key]])
        ) as NonNullable<WorkspaceSessionState[typeof field]>
      },
      references: (kind, id) => this.references(kind, id, 'prior')
    }
  }

  keys(field: SessionMapField): readonly string[] {
    const transition = this.transitions.get(field)
    const keys = transition?.complete ? this.candidateIndex.keys(field) : this.index.keys(field)
    return this.ordered(field, new Set([...keys, ...(transition?.entries?.keys() ?? [])]))
  }

  ids(field: SessionMapField, key: string, kind: SessionReferenceKind): ReadonlySet<string> {
    return new Set([
      ...this.index.ids(field, key, kind),
      ...this.candidateIndex.ids(field, key, kind)
    ])
  }

  ordered(field: SessionMapField, keys: Iterable<string>): readonly string[] {
    return this.orderSelection(
      field,
      [...keys].filter((key) => this.unit(field, key).present)
    )
  }

  orderSelection(field: SessionMapField, keys: Iterable<string>): readonly string[] {
    return this.candidateIndex.ordered(field, keys)
  }

  terminalOwner(tabId: string, selection: 'first' | 'last' = 'last'): string | undefined {
    const units = this.references('tab', tabId).filter((unit) => unit.field === 'tabsByWorktree')
    return selection === 'first' ? units[0]?.key : units.at(-1)?.key
  }

  references(
    kind: SessionReferenceKind,
    id: string,
    phase: 'prior' | 'candidate' = 'candidate'
  ): readonly SessionUnitAddress[] {
    if (phase === 'prior') {
      return this.index.references(kind, id)
    }
    const combined = [
      ...this.index
        .references(kind, id)
        .filter((unit) => !this.changed.get(unit.field)?.has(unit.key)),
      ...this.candidateIndex.references(kind, id)
    ]
    return combined.sort((a, b) => {
      if (a.field !== b.field) {
        return SESSION_MAP_FIELDS.indexOf(a.field) - SESSION_MAP_FIELDS.indexOf(b.field)
      }
      if (a.key === b.key) {
        return 0
      }
      return this.orderSelection(a.field, [a.key, b.key])[0] === a.key ? -1 : 1
    })
  }

  map<F extends SessionMapField>(
    field: F,
    keys: Iterable<string>
  ): NonNullable<WorkspaceSessionState[F]> {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every value is read from this exact typed session map field.
    return Object.fromEntries(
      this.ordered(field, keys).flatMap((key) => {
        const entry = this.unit(field, key)
        return entry.present ? [[key, entry.value]] : []
      })
    ) as NonNullable<WorkspaceSessionState[F]>
  }

  terminalOccurrenceCount(tabId: string, phase: 'prior' | 'candidate' = 'candidate'): number {
    if (phase === 'prior') {
      return this.index.terminalOccurrenceCount(tabId)
    }
    let count = this.candidateIndex.terminalOccurrenceCount(tabId)
    for (const unit of this.index.references('tab', tabId)) {
      if (unit.field === 'tabsByWorktree' && !this.changed.get(unit.field)?.has(unit.key)) {
        count += this.index.terminalUnitOccurrenceCount(unit.field, unit.key, tabId)
      }
    }
    return count
  }

  prepare(options: {
    kind: SessionAdmissionKind
    fullReplacement?: boolean
    partitionDeleted?: boolean
    relatedViews?: ReadonlyMap<string, { prior: unknown; next: unknown }>
    effects?: readonly (() => void)[]
  }): PreparedSession {
    const root = this.snapshot()
    const units: SessionUnitChange[] = []
    const orders = new Map<SessionMapField, readonly string[]>()
    for (const [field, transition] of this.transitions) {
      if (isSessionMapField(field)) {
        for (const key of this.changedKeys(field)) {
          const before = this.unit(field, key, 'prior'),
            after = this.unit(field, key)
          if (before.present !== after.present || before.value !== after.value) {
            units.push({
              field,
              key,
              prior: before.value,
              next: after.value,
              priorPresent: before.present,
              nextPresent: after.present
            })
          }
        }
        if (transition.complete) {
          orders.set(field, this.keys(field))
        }
        if (
          Object.hasOwn(this.prior, field) === Object.hasOwn(root, field) &&
          (this.prior[field] === undefined) === (root[field] === undefined) &&
          !transition.complete
        ) {
          continue
        }
        if (
          Object.hasOwn(this.prior, field) === Object.hasOwn(root, field) &&
          (this.prior[field] === undefined) === (root[field] === undefined) &&
          Object.keys(this.prior[field] ?? {}).join('\0') ===
            Object.keys(root[field] ?? {}).join('\0')
        ) {
          continue
        }
      } else if (
        this.prior[field] === root[field] &&
        Object.hasOwn(this.prior, field) === Object.hasOwn(root, field)
      ) {
        continue
      }
      units.push({
        field,
        key: null,
        prior: this.prior[field],
        next: root[field],
        priorPresent: Object.hasOwn(this.prior, field),
        nextPresent: Object.hasOwn(root, field)
      })
    }
    this.sealed = true
    return {
      prior: this.prior,
      root,
      ...options,
      fullReplacement: options.fullReplacement ?? false,
      partitionDeleted: options.partitionDeleted ?? false,
      units,
      orders,
      effects: options.effects ?? []
    }
  }
}

export function readSessionUnit<F extends SessionMapField>(
  source: WorkspaceSessionState | SessionUnitView,
  field: F,
  key: string
): SessionEntry<F> | undefined {
  if (isSessionUnitView(source)) {
    return source.unit(field, key).value
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the selected map F and its string key retain the same entry type.
  return source[field]?.[key] as SessionEntry<F> | undefined
}
