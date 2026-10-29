import { describe, expect, it } from 'vitest'
import { createStore } from 'zustand/vanilla'
import { useAppStore } from './index'
import {
  editSessionSource,
  SESSION_SOURCE_RECEIPT,
  type SessionSourceWrite
} from './session-source-edits'
import {
  replaceSessionSourceFields,
  withSessionSourceWrites
} from './session-source-write-boundary'
import {
  discoverSessionSources,
  type SessionSourceDiscovery
} from '../lib/session-source-discovery'
import type { AppState } from './types'
import { withEditorBufferRecords } from './editor-buffer-record-lifecycle'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { TEST_REPO } from './slices/worktrees-slice-test-fixtures'
import { SessionSourceReceipts } from '../lib/session-source-receipts'

function fixture(): AppState {
  return {
    ...useAppStore.getState(),
    activeTabId: null,
    editorDrafts: { a: 'before', b: 'untouched' },
    openFiles: [],
    tabsByWorktree: {},
    sshConnectionStates: new Map()
  }
}

function verify(before: AppState, write: SessionSourceWrite<AppState>): AppState {
  const next = { ...before, ...write }
  expect(write[SESSION_SOURCE_RECEIPT].changes).toEqual(
    discoverSessionSources(before, next).changes
  )
  expect(write[SESSION_SOURCE_RECEIPT].full).toBe(discoverSessionSources(before, next).full)
  return next
}

describe('atomic named source edits', () => {
  it('matches the independent native diff for presence and restored edits with frozen roots', () => {
    const before = fixture()
    Object.freeze(before.editorDrafts)
    Object.freeze(before)
    const edit = editSessionSource(before)
    edit.set('editorDrafts', 'a', 'changed')
    edit.remove('editorDrafts', 'b')
    edit.set('editorDrafts', 'a', 'before')
    edit.set('editorDrafts', 'c', 'new')
    const write = edit.finish()
    const next = verify(before, write)
    expect(next.editorDrafts).toEqual({ a: 'before', c: 'new' })
    expect(before.editorDrafts).toEqual({ a: 'before', b: 'untouched' })
    Object.freeze(next.editorDrafts)
    edit.set('editorDrafts', 'c', 'later')
    expect(next.editorDrafts.c).toBe('new')
    verify(before, edit.finish())
  })

  it('uses full replacement for order changes and preserves integer property order', () => {
    const before = fixture()
    verify(
      before,
      editSessionSource(before)
        .set('editorDrafts', '2', 'two')
        .set('editorDrafts', '1', 'one')
        .finish()
    )
    const reordered = editSessionSource(before)
      .remove('editorDrafts', 'a')
      .set('editorDrafts', 'a', 'before')
      .finish()
    expect(reordered[SESSION_SOURCE_RECEIPT].full).toBe(true)
    expect(Object.keys(reordered.editorDrafts!)).toEqual(['b', 'a'])
    const empty = editSessionSource(before)
      .replace('editorDrafts', {})
      .set('editorDrafts', 'c', 'new')
      .finish()
    expect(empty.editorDrafts).toEqual({ c: 'new' })
    expect(before.editorDrafts).toEqual({ a: 'before', b: 'untouched' })
  })

  it('keeps scalar edits in the same write receipt', () => {
    const before = fixture()
    verify(
      before,
      editSessionSource(before)
        .scalar('activeTabId', 'tab')
        .set('editorDrafts', 'a', 'next')
        .finish()
    )
  })

  it('carries duplicate catalog occurrences from native traversal', () => {
    const row = { ...TEST_REPO, id: 'same' }
    const before = { ...fixture(), repos: [row, row] }
    const edit = editSessionSource(before)
    const repos = before.repos.map((repo, index) => {
      const next = index === 0 ? { ...repo, name: 'renamed' } : repo
      edit.catalog('repos', repo, next)
      return next
    })
    const write = edit.catalogs('repos', repos).finish()
    verify(before, write)
    expect(write[SESSION_SOURCE_RECEIPT].catalogs?.repos?.get('same')).toEqual(repos)
    expect(before.repos).toEqual([row, row])
  })

  it('coalesces pending keyed receipts against the captured source without enumerating Records', () => {
    const before = fixture()
    const first = editSessionSource(before).set('editorDrafts', 'a', 'temporary').finish()
    const middle = { ...before, ...first }
    const second = editSessionSource(middle)
      .set('editorDrafts', 'a', before.editorDrafts.a)
      .remove('editorDrafts', 'b')
      .finish()
    const after = { ...middle, ...second }
    const pending = new SessionSourceReceipts()
    pending.add(first[SESSION_SOURCE_RECEIPT])
    pending.add(second[SESSION_SOURCE_RECEIPT])
    const native = discoverSessionSources(before, after)
    const trap = <T extends object>(record: T): T =>
      new Proxy(record, {
        ownKeys: () => {
          throw new Error('unrelated enumeration')
        }
      })
    const receipt = pending.take(
      { ...before, editorDrafts: trap(before.editorDrafts) },
      { ...after, editorDrafts: trap(after.editorDrafts) }
    )
    expect(receipt.changes).toEqual(native.changes)
  })
})

describe('source write identity gate', () => {
  it('composes reconciled file mirrors and shared drafts before notifying subscribers', () => {
    const store = createStore<AppState>()(withEditorBufferRecords(fixture, false))
    const file = {
      id: 'a',
      filePath: '/repo/a.md',
      relativePath: 'a.md',
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      language: 'markdown',
      mode: 'edit' as const,
      isDirty: false
    }
    store.setState(
      replaceSessionSourceFields({
        ...fixture(),
        openFiles: [{ ...file, isDirty: true }],
        editorDrafts: { a: 'shared' }
      }),
      true
    )
    const before = store.getState()
    let receipt: SessionSourceDiscovery | undefined
    store.subscribe(() => {
      receipt = store.getSessionSourceReceipt()
    })
    const edit = editSessionSource(before)
    const rows = before.openFiles.map((row) => {
      edit.file(row, row)
      return row
    })
    const added = { ...file, id: 'b' }
    edit.file(undefined, added)
    rows.push(added)
    store.setState(edit.files(rows).finish())
    const after = store.getState()
    expect(after.openFiles.every((row) => row.isDirty)).toBe(true)
    expect(receipt?.changes).toEqual(discoverSessionSources(before, after).changes)
    expect(receipt?.full).toBe(false)
  })
  it('publishes receipts before synchronous subscribers, including nested notifications', () => {
    const store = createStore<AppState>()(withSessionSourceWrites(fixture, true))
    let nested = false
    const captured: string[][] = []
    store.subscribe(() => {
      if (!nested) {
        nested = true
        store.setState(editSessionSource(store.getState()).scalar('activeTabId', 'nested').finish())
      }
    })
    store.subscribe(() => captured.push([...store.getSessionSourceReceipt()!.changes.keys()]))
    store.setState(editSessionSource(store.getState()).set('editorDrafts', 'a', 'outer').finish())
    expect(captured).toEqual([['activeTabId'], ['editorDrafts']])
    expect(store.getSessionSourceReceipt()).toBeUndefined()
  })

  it('rejects unreported writes in development and declares one full boundary in production', () => {
    for (const development of [true, false]) {
      const store = createStore<AppState>()(withSessionSourceWrites(fixture, development))
      let full = false
      store.subscribe(() => {
        full = Boolean(store.getSessionSourceReceipt()?.full)
      })
      // SAFETY: this deliberately bypasses the source setter type to exercise its one runtime gate.
      const unsupported = { editorDrafts: {} } as SessionSourceWrite<AppState>
      if (development) {
        expect(() => store.setState(unsupported)).toThrow(
          'Unreported session source write: editorDrafts'
        )
      } else {
        store.setState(unsupported)
        expect(full).toBe(true)
      }
      store.setState(replaceSessionSourceFields(fixture()), true)
      expect(full).toBe(true)
    }
  })
})
