import type { SessionUnitAddress } from './session-unit-index'
import { SESSION_MAP_FIELDS, type SessionMapField } from './session-change-set'

import type { SessionUnitReader } from './session-unit-reader'
export type SessionUnitSelection = Map<SessionMapField, Set<string>>

export function selectSessionUnits(
  reader: SessionUnitReader,
  extra: readonly SessionUnitAddress[] = [],
  full = false
): SessionUnitSelection {
  const selected: SessionUnitSelection = new Map()
  if (full) {
    for (const field of SESSION_MAP_FIELDS) {
      selected.set(field, new Set([...reader.index.keys(field), ...reader.keys(field)]))
    }
    for (const { field, key } of extra) {
      selected.get(field)!.add(key)
    }
    const revisions = selected.get('terminalTopologyRevisionByRepoId')!
    for (const [field, keys] of selected) {
      for (const key of keys) {
        for (const repo of reader.ids(field, key, 'repo')) {
          revisions.add(repo)
        }
      }
    }
    for (const [field, keys] of selected) {
      selected.set(field, new Set(reader.orderSelection(field, keys)))
    }
    return selected
  }
  const queue = [...extra]
  for (const field of SESSION_MAP_FIELDS) {
    const keys = reader.changedKeys(field)
    for (const key of keys) {
      queue.push({ field, key })
    }
  }
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const { field, key } = queue[cursor]
    const keys = selected.get(field) ?? new Set<string>()
    if (keys.has(key)) {
      continue
    }
    keys.add(key)
    selected.set(field, keys)
    for (const kind of [
      'owner',
      'tab',
      'pane',
      'file',
      'page',
      'browser',
      'pty',
      'leaf'
    ] as const) {
      for (const id of reader.ids(field, key, kind)) {
        queue.push(...reader.references(kind, id, 'prior'), ...reader.references(kind, id))
      }
    }
    for (const repo of reader.ids(field, key, 'repo')) {
      queue.push({ field: 'terminalTopologyRevisionByRepoId', key: repo })
    }
    if (field === 'terminalTopologyRevisionByRepoId' && reader.touches(field)) {
      queue.push(...reader.references('repo', key, 'prior'), ...reader.references('repo', key))
    }
  }
  for (const [field, keys] of selected) {
    selected.set(field, new Set(reader.orderSelection(field, keys)))
  }
  return selected
}
