import { describe, expect, it } from 'vitest'
import { createStore } from 'zustand/vanilla'
import type { DiffComment } from '../../../shared/diff-comment-types'
import type { Worktree } from '../../../shared/worktree/types'
import { makeWorktree } from './slices/worktrees-slice-test-fixtures'
import { findDiffCommentRows, selectWorktreeDiffComments } from './worktree-diff-comments-selector'

const WORKTREE_ID = 'repo-1::/work/target'
type NoteState = Parameters<typeof selectWorktreeDiffComments>[0]

function comments(id: string): DiffComment[] {
  return [
    {
      id,
      worktreeId: WORKTREE_ID,
      filePath: 'src/index.ts',
      lineNumber: 1,
      body: id,
      createdAt: 1,
      updatedAt: 1,
      source: 'diff',
      side: 'modified'
    }
  ]
}

function state(rows: Worktree[]): NoteState {
  return {
    worktreesByRepo: { 'repo-1': rows },
    activeWorktreeId: WORKTREE_ID,
    activeWorkspaceExecutionHostId: 'local'
  }
}

describe('active-host diff comment row indexing', () => {
  it.each([100, 1_000])(
    'does not rescan %i repo rows across unrelated notifications',
    (rowCount) => {
      let idReads = 0
      const notes = comments('note')
      const rows = Array.from({ length: rowCount }, (_, index) => {
        const id = index === rowCount - 1 ? WORKTREE_ID : `repo-1::/work/wt-${index}`
        const row = makeWorktree({
          id,
          repoId: 'repo-1',
          hostId: 'local',
          ...(id === WORKTREE_ID ? { diffComments: notes } : {})
        })
        Object.defineProperty(row, 'id', {
          enumerable: true,
          get: () => {
            idReads += 1
            return id
          }
        })
        return row
      })
      const store = createStore(() => ({ ...state(rows), unrelated: 0 }))
      expect(selectWorktreeDiffComments(store.getState(), WORKTREE_ID)).toBe(notes)
      idReads = 0
      let publications = 0
      const stop = store.subscribe((next) => {
        publications += 1
        expect(selectWorktreeDiffComments(next, WORKTREE_ID)).toBe(notes)
      })
      for (let index = 0; index < 50; index += 1) {
        store.setState((next) => ({ unrelated: next.unrelated + 1 }))
      }
      stop()
      expect(publications).toBe(50)
      expect(idReads).toBe(0)
    }
  )

  it('retains duplicate rows, selected host and captured-note disambiguation', () => {
    const localFirst = makeWorktree({
      id: WORKTREE_ID,
      repoId: 'repo-1',
      hostId: 'local',
      diffComments: comments('local-first')
    })
    const remote = makeWorktree({
      id: WORKTREE_ID,
      repoId: 'repo-1',
      hostId: 'ssh:build',
      diffComments: comments('remote')
    })
    const localLast = makeWorktree({
      id: WORKTREE_ID,
      repoId: 'repo-1',
      hostId: 'local',
      diffComments: comments('local-last')
    })
    const initial = state([localFirst, remote, localLast])
    expect(findDiffCommentRows(initial, WORKTREE_ID)?.worktrees).toEqual([localFirst, localLast])
    expect(selectWorktreeDiffComments(initial, WORKTREE_ID)).toBe(localLast.diffComments)
    expect(
      selectWorktreeDiffComments(
        { ...initial, activeWorkspaceExecutionHostId: 'ssh:build' },
        WORKTREE_ID
      )
    ).toBe(remote.diffComments)
    expect(
      findDiffCommentRows(initial, WORKTREE_ID, { commentIds: new Set(['remote']) })?.worktrees
    ).toEqual([remote])
    expect(
      findDiffCommentRows(initial, WORKTREE_ID, { twin: { hostId: 'local' } })?.worktrees
    ).toEqual([localFirst, localLast])
  })

  it('ignores an identical id published in another repository bucket', () => {
    const foreign = makeWorktree({
      id: WORKTREE_ID,
      repoId: 'other-repo',
      hostId: 'local',
      diffComments: comments('foreign')
    })
    const initial: NoteState = {
      ...state([]),
      worktreesByRepo: { 'repo-1': [], 'other-repo': [foreign] }
    }
    expect(findDiffCommentRows(initial, WORKTREE_ID)).toBeNull()
    expect(findDiffCommentRows(initial, WORKTREE_ID, { twin: { hostId: 'local' } })).toBeNull()
  })

  it('reads replaced and removed buckets without invalidating an older immutable snapshot', () => {
    const first = makeWorktree({
      id: WORKTREE_ID,
      repoId: 'repo-1',
      hostId: 'local',
      diffComments: comments('first')
    })
    const replacement = { ...first, diffComments: comments('replacement') }
    const initial = state([first])
    const next = state([replacement])
    expect(selectWorktreeDiffComments(initial, WORKTREE_ID)).toBe(first.diffComments)
    expect(selectWorktreeDiffComments(next, WORKTREE_ID)).toBe(replacement.diffComments)
    expect(selectWorktreeDiffComments(initial, WORKTREE_ID)).toBe(first.diffComments)
    expect(selectWorktreeDiffComments(state([]), WORKTREE_ID)).toBeUndefined()
  })
})
