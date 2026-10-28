import type { SessionEntry } from './session-unit-reader'
import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from './constants'
import { SESSION_MAP_FIELDS } from './session-change-set'
import { SessionUnitIndex } from './session-unit-index'
import { SessionUnitReader } from './session-unit-reader'
import { patchSessionUnits } from './workspace-layout/workspace-layout-record-patch'
import type { WorkspaceSessionState } from './workspace-session-state-types'

function root(field: string, shape: 'absent' | 'undefined' | 'empty' | 'populated') {
  const value = getDefaultWorkspaceSession()
  Reflect.deleteProperty(value, field)
  if (shape !== 'absent') {
    Object.assign(value, {
      [field]:
        shape === 'undefined'
          ? undefined
          : shape === 'empty'
            ? {}
            : { selected: field === 'tabsByWorktree' ? [] : 'value' }
    })
  }
  return value
}

function freeze(value: WorkspaceSessionState): WorkspaceSessionState {
  for (const map of Object.values(value)) {
    if (map && typeof map === 'object') {
      Object.freeze(map)
    }
  }
  return Object.freeze(value)
}

const shapes = ['absent', 'undefined', 'empty', 'populated'] as const

describe('scope-aware map field presence', () => {
  for (const field of SESSION_MAP_FIELDS) {
    it(`${field}: complete, selected and unmentioned input preserve their distinct domains`, () => {
      for (const shape of shapes) {
        const prior = freeze(root(field, shape))
        const original = structuredClone(prior)
        const index = new SessionUnitIndex(prior)
        // Unmentioned patch input retains own-undefined and absent shapes exactly.
        const untouched = new SessionUnitReader(prior, index)
        expect(untouched.snapshot()).toBe(prior)
        expect(untouched.hasField(field)).toBe(Object.hasOwn(prior, field))
        for (const kind of ['complete', 'selected'] as const) {
          for (const output of ['absent', 'empty'] as const) {
            const after = root(field, output)
            const reader = new SessionUnitReader(prior, index)
            patchSessionUnits(
              reader,
              prior,
              after,
              kind === 'complete'
                ? { kind }
                : { kind, fields: new Map([[field, new Set(['selected'])]]) }
            )
            const next = reader.snapshot()
            const required = field === 'tabsByWorktree' || field === 'terminalLayoutsByTabId'
            // An unchanged serializer field is unmentioned; otherwise output intent governs emptiness.
            const changed = shape === 'populated' || (shape === 'empty') !== (output === 'empty')
            const present = changed ? required || output === 'empty' : Object.hasOwn(prior, field)
            expect(Object.hasOwn(next, field), `${shape}/${kind}/${output}`).toBe(present)
            expect(reader.hasField(field)).toBe(present)
            expect(reader.entryCount(field)).toBe(new SessionUnitIndex(next).size(field))
          }
        }
        expect(prior).toStrictEqual(original)
      }
    })
  }

  it('selected omission keeps orphan own-undefined entries without enumerating unrelated content', () => {
    const prior = freeze({
      ...getDefaultWorkspaceSession(),
      terminalPtyIncarnationsByPaneKey: { selected: 'value', orphan: undefined }
    })
    const index = new SessionUnitIndex(prior)
    expect(index.size('terminalPtyIncarnationsByPaneKey')).toBe(2)
    const reader = new SessionUnitReader(prior, index)
    reader.write('terminalPtyIncarnationsByPaneKey', 'selected', {
      present: false,
      value: undefined
    })
    reader.reconcileField('terminalPtyIncarnationsByPaneKey', { kind: 'output', present: false })
    expect(reader.entryCount('terminalPtyIncarnationsByPaneKey')).toBe(1)
    expect(reader.hasField('terminalPtyIncarnationsByPaneKey')).toBe(true)
    expect(reader.snapshot().terminalPtyIncarnationsByPaneKey).toStrictEqual({ orphan: undefined })
  })

  it('orders a newly inserted integer key like a full materialized Record', () => {
    const prior = freeze({
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { '2': [], other: [] }
    })
    const reader = new SessionUnitReader(prior, new SessionUnitIndex(prior))
    reader.write('tabsByWorktree', '1', { present: true, value: [] })
    const fullKeys = Object.keys(reader.snapshot().tabsByWorktree)
    expect(fullKeys).toEqual(['1', '2', 'other'])
    expect(reader.keys('tabsByWorktree')).toEqual(fullKeys)
    expect(reader.ordered('tabsByWorktree', ['other', '1', '2'])).toEqual(fullKeys)
  })

  it('clear then add uses the replacement domain and rollback restores exact presence', () => {
    for (const shape of shapes) {
      const prior = freeze(root('terminalPtyIncarnationsByPaneKey', shape))
      const reader = new SessionUnitReader(prior, new SessionUnitIndex(prior))
      reader.replace('terminalPtyIncarnationsByPaneKey', { present: true, value: {} })
      reader.write('terminalPtyIncarnationsByPaneKey', 'new:leaf', { present: true, value: 'new' })
      expect(reader.snapshot().terminalPtyIncarnationsByPaneKey).toEqual({ 'new:leaf': 'new' })
      const next = reader.snapshot()
      const rollback = new SessionUnitReader(next, new SessionUnitIndex(next))
      rollback.replace(
        'terminalPtyIncarnationsByPaneKey',
        Object.hasOwn(prior, 'terminalPtyIncarnationsByPaneKey')
          ? { present: true, value: prior.terminalPtyIncarnationsByPaneKey }
          : { present: false, value: undefined }
      )
      rollback.reconcileField('terminalPtyIncarnationsByPaneKey', {
        kind: 'rollback',
        present: Object.hasOwn(prior, 'terminalPtyIncarnationsByPaneKey')
      })
      expect(rollback.snapshot()).toStrictEqual(prior)
    }
  })
})

describe('complete own-undefined replacement followed by keyed output', () => {
  it('publishes a subsequent incarnation entry through the same presence result as the reader', () => {
    const prior = freeze({
      ...getDefaultWorkspaceSession(),
      terminalPtyIncarnationsByPaneKey: { 'prior:leaf': 'old' }
    })
    const reader = new SessionUnitReader(prior, new SessionUnitIndex(prior))
    reader.replace('terminalPtyIncarnationsByPaneKey', { present: true, value: undefined })
    reader.write('terminalPtyIncarnationsByPaneKey', 'next:leaf', { present: true, value: 'fresh' })
    expect(reader.hasField('terminalPtyIncarnationsByPaneKey')).toBe(true)
    expect(reader.entryCount('terminalPtyIncarnationsByPaneKey')).toBe(1)
    expect(reader.unit('terminalPtyIncarnationsByPaneKey', 'next:leaf').value).toBe('fresh')
    const installed = reader.snapshot()
    expect(installed.terminalPtyIncarnationsByPaneKey).toStrictEqual({ 'next:leaf': 'fresh' })
    expect(new SessionUnitIndex(installed).size('terminalPtyIncarnationsByPaneKey')).toBe(1)
    expect(prior.terminalPtyIncarnationsByPaneKey).toStrictEqual({ 'prior:leaf': 'old' })
  })
})

describe('resolved field transitions against independent native values', () => {
  for (const field of SESSION_MAP_FIELDS) {
    it(`${field}: replacement, promotion, selected edits and retained snapshots agree`, () => {
      for (const shape of shapes) {
        const prior = freeze(root(field, shape))
        const reader = new SessionUnitReader(prior, new SessionUnitIndex(prior))
        let model = { ...prior }
        const retained: { root: WorkspaceSessionState; saved: WorkspaceSessionState }[] = []
        const compare = () => {
          const snapshot = reader.snapshot()
          expect(snapshot).toStrictEqual(model)
          expect(reader.snapshot()).toBe(snapshot)
          expect(reader.hasField(field)).toBe(Object.hasOwn(model, field))
          expect(reader.keys(field)).toEqual(Object.keys(model[field] ?? {}))
          expect(reader.entryCount(field)).toBe(Object.keys(model[field] ?? {}).length)
          for (const key of ['selected', '1', '2', 'next', 'ownUndefined']) {
            expect(reader.unit(field, key).present).toBe(Object.hasOwn(model[field] ?? {}, key))
            expect(reader.unit(field, key).value).toBe(Reflect.get(model[field] ?? {}, key))
          }
          retained.push({ root: snapshot, saved: structuredClone(snapshot) })
          freeze(snapshot)
          for (const old of retained) {
            expect(old.root).toStrictEqual(old.saved)
          }
        }
        compare()
        // A complete own-undefined replacement followed by a set starts a new empty domain.
        reader.replace(field, { present: true, value: undefined })
        model = { ...model, [field]: undefined }
        compare()
        const value = field === 'tabsByWorktree' ? [] : 'fresh'
        // SAFETY: the generic policy matrix uses opaque entries; index parsing accepts unknown shapes.
        const entry = value as SessionEntry<typeof field>
        reader.write(field, 'next', { present: true, value: entry })
        model = { ...model, [field]: { next: value } }
        compare()
        reader.write(field, 'ownUndefined', { present: true, value: undefined })
        model = { ...model, [field]: { ...model[field], ownUndefined: undefined } }
        compare()
        reader.write(field, 'next', { present: false, value: undefined })
        const next = { ...model[field] }
        delete next.next
        model = { ...model, [field]: next }
        compare()
        reader.write(field, 'ownUndefined', { present: false, value: undefined })
        model = { ...model, [field]: {} }
        if (
          [
            'sleepingAgentSessionsByPaneKey',
            'terminalPtyIncarnationsByPaneKey',
            'closedTerminalTabTombstonesByTabId'
          ].includes(field)
        ) {
          Reflect.deleteProperty(model, field)
        }
        compare()
        reader.replace(field, { present: false, value: undefined })
        model = { ...model }
        if (field === 'tabsByWorktree' || field === 'terminalLayoutsByTabId') {
          Object.assign(model, { [field]: {} })
        } else {
          Reflect.deleteProperty(model, field)
        }
        compare()
        // An explicit empty whole-field result survives even when selected emptiness retires a field.
        reader.replace(field, { present: true, value: {} })
        model = { ...model, [field]: {} }
        compare()
        // Whole replacements, including delete/reinsert, follow native integer and string order.
        const ordered = { '2': value, selected: value, '1': value }
        // SAFETY: the matrix supplies the same opaque entry type used above.
        reader.replace(field, {
          present: true,
          value: ordered as NonNullable<WorkspaceSessionState[typeof field]>
        })
        model = { ...model, [field]: ordered }
        compare()
        const reordered = { ...ordered }
        Reflect.deleteProperty(reordered, 'selected')
        reordered.selected = value
        // SAFETY: native replacement keeps the matrix's opaque entry type.
        reader.replace(field, {
          present: true,
          value: reordered as NonNullable<WorkspaceSessionState[typeof field]>
        })
        model = { ...model, [field]: reordered }
        compare()
        const prepared = reader.prepare({ kind: 'authoritative' })
        expect(prepared.root).toBe(reader.snapshot())
        expect(prepared.root).toStrictEqual(model)
        expect(() => reader.write(field, 'new', { present: true, value: entry })).toThrow('sealed')
        expect(prior).toStrictEqual(retained[0].saved)
      }
    })
  }
})
