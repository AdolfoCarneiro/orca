import { describe, expect, it } from 'vitest'
import { buildRows } from './worktree-list/grouping/build-rows.test-fixture'
import { PINNED_GROUP_KEY } from '../../../../shared/sidebar-list/group-keys'
import { repo, worktree, repoMap, makeDetectedWorktree } from './worktree-list-groups-test-fixtures'

describe('buildRows with hidden-worktree notices', () => {
  it('emits an empty ungrouped repo placeholder header', () => {
    const rows = buildRows(
      'repo',
      [],
      repoMap,
      null,
      new Set(),
      new Map([[repo.id, 0]]),
      undefined,
      'manual',
      {},
      new Map(),
      false,
      undefined,
      [],
      new Set([repo.id])
    )

    expect(rows).toMatchObject([{ type: 'header', key: 'repo:repo-1', label: 'orca' }])
  })

  it('skips stale empty placeholder repo ids that are absent from repoMap', () => {
    const rows = buildRows(
      'repo',
      [],
      new Map(),
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      {},
      new Map(),
      false,
      undefined,
      [],
      new Set([repo.id])
    )

    expect(rows).toEqual([])
  })

  it('emits a new external worktrees inbox row before repo worktree rows', () => {
    const inboxWorktrees = [
      makeDetectedWorktree({ id: 'inbox-1', displayName: 'payments-refactor' }),
      makeDetectedWorktree({ id: 'inbox-2', displayName: 'auth-cache-debug' })
    ]
    const rows = buildRows(
      'repo',
      [worktree],
      repoMap,
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      {},
      new Map([[worktree.id, worktree]]),
      false,
      undefined,
      [],
      new Set(),
      new Map([[repo.id, { repo, inboxWorktrees }]])
    )

    expect(rows).toMatchObject([
      { type: 'header', key: 'repo:repo-1' },
      {
        type: 'new-external-worktrees-inbox',
        key: 'new-external-worktrees-inbox:repo-1',
        repo: { id: 'repo-1' },
        inboxWorktrees: [{ id: 'inbox-1' }, { id: 'inbox-2' }]
      },
      { type: 'item', worktree: { id: 'wt-1' } }
    ])
  })

  it('suppresses the new external worktrees inbox row when the repo group is collapsed', () => {
    const rows = buildRows(
      'repo',
      [worktree],
      repoMap,
      null,
      new Set(['repo:repo-1']),
      undefined,
      undefined,
      undefined,
      {},
      new Map([[worktree.id, worktree]]),
      false,
      undefined,
      [],
      new Set(),
      new Map([[repo.id, { repo, inboxWorktrees: [makeDetectedWorktree()] }]])
    )

    expect(rows).toMatchObject([{ type: 'header', key: 'repo:repo-1' }])
  })

  it('emits a repo header and inbox row when no visible worktree rows remain', () => {
    const rows = buildRows(
      'repo',
      [],
      repoMap,
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      {},
      new Map(),
      false,
      undefined,
      [],
      new Set(),
      new Map([[repo.id, { repo, inboxWorktrees: [makeDetectedWorktree()] }]])
    )

    expect(rows).toMatchObject([
      { type: 'header', key: 'repo:repo-1' },
      {
        type: 'new-external-worktrees-inbox',
        key: 'new-external-worktrees-inbox:repo-1'
      }
    ])
  })

  it('keeps the inbox group when the repo only has a pinned worktree', () => {
    const pinnedWorktree = { ...worktree, id: 'wt-pinned', isPinned: true }
    const rows = buildRows(
      'repo',
      [pinnedWorktree],
      repoMap,
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      {},
      new Map([[pinnedWorktree.id, pinnedWorktree]]),
      false,
      undefined,
      [],
      new Set(),
      new Map([[repo.id, { repo, inboxWorktrees: [makeDetectedWorktree()] }]])
    )

    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'item',
          sectionKey: PINNED_GROUP_KEY,
          worktree: expect.objectContaining({ id: pinnedWorktree.id })
        }),
        expect.objectContaining({ type: 'header', key: `repo:${repo.id}` }),
        expect.objectContaining({
          type: 'new-external-worktrees-inbox',
          key: `new-external-worktrees-inbox:${repo.id}`
        })
      ])
    )
    expect(
      rows.some(
        (row) =>
          row.type === 'item' &&
          row.sectionKey === `repo:${repo.id}` &&
          row.worktree.id === pinnedWorktree.id
      )
    ).toBe(false)
  })

  it('does not emit new external worktrees inbox rows outside repo grouping', () => {
    const rows = buildRows(
      'workspace-status',
      [worktree],
      repoMap,
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      {},
      new Map([[worktree.id, worktree]]),
      false,
      undefined,
      [],
      new Set(),
      new Map([[repo.id, { repo, inboxWorktrees: [makeDetectedWorktree()] }]])
    )

    expect(rows.some((row) => row.type === 'new-external-worktrees-inbox')).toBe(false)
  })

  it('duplicates pinned worktrees into repo groups when the policy allows it', () => {
    const pinnedWorktree = { ...worktree, id: 'wt-pinned', isPinned: true }
    const rows = buildRows(
      'repo',
      [pinnedWorktree],
      repoMap,
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      {},
      new Map([[pinnedWorktree.id, pinnedWorktree]]),
      false,
      { showPinnedWorktreesInGroups: true } as never,
      [],
      new Set()
    )

    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'item',
          sectionKey: PINNED_GROUP_KEY,
          worktree: expect.objectContaining({ id: 'wt-pinned' })
        }),
        expect.objectContaining({
          type: 'item',
          sectionKey: `repo:${repo.id}`,
          worktree: expect.objectContaining({ id: 'wt-pinned' })
        })
      ])
    )
  })

  it('keeps the repo hidden-worktrees notice visible when Pinned is collapsed', () => {
    const pinnedWorktree = { ...worktree, id: 'wt-pinned', isPinned: true }
    const rows = buildRows(
      'repo',
      [pinnedWorktree],
      repoMap,
      null,
      new Set(['pinned']),
      undefined,
      undefined,
      undefined,
      {},
      new Map([[pinnedWorktree.id, pinnedWorktree]]),
      false,
      undefined,
      [],
      new Set(),
      new Map([[repo.id, { repo, inboxWorktrees: [makeDetectedWorktree()] }]])
    )

    expect(rows).toMatchObject([
      { type: 'header', key: 'pinned' },
      { type: 'header', key: 'repo:repo-1' },
      { type: 'new-external-worktrees-inbox', key: 'new-external-worktrees-inbox:repo-1' }
    ])
    expect(
      rows.filter((row) => row.type === 'item' && row.sectionKey !== PINNED_GROUP_KEY)
    ).toEqual([])
  })
})
