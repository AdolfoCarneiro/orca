import { describe, expect, it } from 'vitest'
import { createStore } from 'zustand/vanilla'
import { hostWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import {
  resolveIndexedFolderWorkspaceOwner,
  resolveIndexedProjectGroupOwner
} from '@/lib/worktree-runtime-owner-index'
import type { AppState } from './types'
import { makeFolderWorkspace } from './slices/worktrees-slice-test-fixtures'
import { findKnownWorktreeById } from './slices/worktrees/listing/detected-worktree-meta'
import { selectWorkspaceByHostTarget } from './workspace-record-selectors'

type FolderLookupState = Pick<
  AppState,
  'worktreesByRepo' | 'detectedWorktreesByRepo' | 'folderWorkspaces' | 'floatingWorkspacePath'
>

function stateWithFolders(folderWorkspaces: AppState['folderWorkspaces']): FolderLookupState {
  return {
    worktreesByRepo: {},
    detectedWorktreesByRepo: {},
    folderWorkspaces,
    floatingWorkspacePath: null
  }
}

describe('folder workspace record lookups', () => {
  it.each([100, 1_000])(
    'does not rescan %i folder records across unrelated store writes',
    (folderCount) => {
      let idReads = 0
      const folderWorkspaces = Array.from({ length: folderCount }, (_, index) => {
        const id = `folder-${index}`
        const row = makeFolderWorkspace({ id, folderPath: `/work/${id}`, executionHostId: 'local' })
        Object.defineProperty(row, 'id', {
          enumerable: true,
          get: () => {
            idReads += 1
            return id
          }
        })
        return row
      })
      const store = createStore(() => ({ ...stateWithFolders(folderWorkspaces), unrelated: 0 }))
      const target = hostWorktreeTarget({
        id: folderWorkspaceKey(`folder-${folderCount - 1}`),
        hostId: 'local'
      })
      const expected = findKnownWorktreeById(store.getState(), target.id)
      expect(expected?.path).toBe(`/work/folder-${folderCount - 1}`)
      expect(selectWorkspaceByHostTarget(store.getState(), target)).toBe(expected)

      let callbacks = 0
      const unsubscribe = Array.from({ length: 25 }, () =>
        store.subscribe((state) => {
          callbacks += 1
          expect(findKnownWorktreeById(state, target.id)).toBe(expected)
          expect(selectWorkspaceByHostTarget(state, target)).toBe(expected)
        })
      )
      idReads = 0
      for (let update = 0; update < 50; update += 1) {
        store.setState((state) => ({ unrelated: state.unrelated + 1 }))
      }
      unsubscribe.forEach((stop) => stop())

      expect(callbacks).toBe(1_250)
      expect(idReads).toBe(0)
    }
  )

  it('keeps UI first matches separate from host-owner ambiguity and last matching owners', () => {
    const id = 'host-twin'
    const localFirst = makeFolderWorkspace({
      id,
      folderPath: '/local/first',
      executionHostId: 'local'
    })
    const localLast = makeFolderWorkspace({
      id,
      folderPath: '/local/last',
      executionHostId: 'local'
    })
    const sshFirst = makeFolderWorkspace({
      id,
      folderPath: '/ssh/first',
      connectionId: 'build-box'
    })
    const sshLast = makeFolderWorkspace({
      id,
      folderPath: '/ssh/last',
      executionHostId: 'ssh:build-box'
    })
    const runtime = makeFolderWorkspace({
      id,
      folderPath: '/runtime',
      executionHostId: 'runtime:env-1'
    })
    const state = stateWithFolders([localFirst, sshFirst, localLast, sshLast, runtime])
    const key = folderWorkspaceKey(id)

    expect(findKnownWorktreeById(state, key)?.path).toBe('/local/first')
    for (const [hostId, path] of [
      ['local', '/local/first'],
      ['ssh:build-box', '/ssh/first'],
      ['runtime:env-1', '/runtime']
    ] as const) {
      const target = hostWorktreeTarget({ id: key, hostId })
      expect(findKnownWorktreeById(state, key, hostId)?.path).toBe(path)
      expect(selectWorkspaceByHostTarget(state, target)?.path).toBe(path)
    }
    expect(resolveIndexedFolderWorkspaceOwner(state.folderWorkspaces, id)).toEqual({
      kind: 'ambiguous'
    })
    expect(resolveIndexedFolderWorkspaceOwner(state.folderWorkspaces, id, 'local')).toEqual({
      kind: 'resolved',
      owner: localLast
    })
    expect(resolveIndexedFolderWorkspaceOwner(state.folderWorkspaces, id, 'ssh:build-box')).toEqual(
      {
        kind: 'resolved',
        owner: sshLast
      }
    )
  })

  it('follows replacement, host changes, reordering and removal without invalidating old snapshots', () => {
    const id = 'changing-folder'
    const key = folderWorkspaceKey(id)
    const local = makeFolderWorkspace({ id, folderPath: '/local', executionHostId: 'local' })
    const ssh = makeFolderWorkspace({ id, folderPath: '/ssh', executionHostId: 'ssh:build-box' })
    const replacement = makeFolderWorkspace({
      ...local,
      folderPath: '/runtime/replaced',
      executionHostId: 'runtime:env-1'
    })
    const original = stateWithFolders([local, ssh])
    const reordered = stateWithFolders([ssh, local])
    const replaced = stateWithFolders([replacement, ssh])
    const removed = stateWithFolders([])
    const snapshots = [
      { state: original, first: '/local', local: '/local', runtime: undefined },
      { state: reordered, first: '/ssh', local: '/local', runtime: undefined },
      {
        state: replaced,
        first: '/runtime/replaced',
        local: undefined,
        runtime: '/runtime/replaced'
      },
      { state: removed, first: undefined, local: undefined, runtime: undefined }
    ]

    for (const snapshot of [...snapshots, ...snapshots.toReversed()]) {
      expect(findKnownWorktreeById(snapshot.state, key)?.path).toBe(snapshot.first)
      expect(findKnownWorktreeById(snapshot.state, key, 'local')?.path).toBe(snapshot.local)
      expect(
        selectWorkspaceByHostTarget(
          snapshot.state,
          hostWorktreeTarget({ id: key, hostId: 'local' })
        )?.path
      ).toBe(snapshot.local)
      expect(findKnownWorktreeById(snapshot.state, key, 'runtime:env-1')?.path).toBe(
        snapshot.runtime
      )
      expect(
        selectWorkspaceByHostTarget(
          snapshot.state,
          hostWorktreeTarget({ id: key, hostId: 'runtime:env-1' })
        )?.path
      ).toBe(snapshot.runtime)
    }
  })

  it('keeps catalog owner resolution metadata private', () => {
    const group = { id: 'group-1', executionHostId: 'local' }
    const groups = [group]
    expect(resolveIndexedProjectGroupOwner(groups, group.id)).toEqual({
      kind: 'resolved',
      owner: group
    })
    expect(resolveIndexedProjectGroupOwner(groups, group.id, 'local')).toEqual({
      kind: 'resolved',
      owner: group
    })
    expect(resolveIndexedProjectGroupOwner(groups, 'missing')).toEqual({ kind: 'missing' })
    expect(resolveIndexedFolderWorkspaceOwner([], 'missing')).toEqual({ kind: 'missing' })
  })
})
