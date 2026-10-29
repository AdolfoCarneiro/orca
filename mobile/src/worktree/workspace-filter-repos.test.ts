import { projectHostSetupProjectionFromRepos } from '../../../src/shared/project-host-setup-projection'
vi.mock('../i18n/mobile-i18n', () => ({
  translate: (_key: string, fallback: string) => fallback,
  getMobileLocale: () => 'en'
}))
import { NO_WORKSPACE_ROW_FILTERS } from '../../../src/shared/workspace-view/workspace-row-filters'
import { describe, expect, it, vi } from 'vitest'
import {
  workspaceProjectFilterSelection,
  buildFilterRepos,
  selectedWorkspaceProjectKeys,
  toggleProjectFilter
} from './workspace-filter-repos'
import { filterWorktrees, type Worktree } from './workspace-list-sections'

function row(worktreeId: string, repoId: string, hostId: Worktree['hostId']): Worktree {
  return {
    worktreeId,
    repoId,
    hostId,
    repo: 'orca',
    branch: 'feature',
    displayName: worktreeId,
    path: `/tmp/${worktreeId}`,
    liveTerminalCount: 0,
    hasAttachedPty: false,
    unread: false,
    isPinned: false,
    linkedPR: null
  }
}

describe('the repo filter', () => {
  it('uses served grouping membership for checked state and preserves partial/offline choices on group edits', () => {
    const repos = ['a', 'b'].map((id) => ({
      id,
      displayName: 'app',
      path: `/repos/${id}`,
      badgeColor: '',
      addedAt: 0,
      upstream: { owner: 'org', repo: 'app' }
    }))
    const projection = projectHostSetupProjectionFromRepos(repos)
    const rows = buildFilterRepos(repos, [], {
      projects: projection.projects,
      projectHostSetups: projection.setups
    })
    expect(rows).toHaveLength(1)
    expect(selectedWorkspaceProjectKeys(rows, ['a', 'offline']).size).toBe(0)
    const next = toggleProjectFilter(rows[0], ['a', 'offline'])
    expect(new Set(next)).toEqual(new Set(['a', 'b', 'offline']))
    expect(selectedWorkspaceProjectKeys(rows, next)).toEqual(new Set([rows[0].key]))
    expect(toggleProjectFilter(rows[0], next)).toEqual(['offline'])
  })

  it("lists each host's same-named repo separately, by id, as the desktop's filter does", () => {
    const repos = buildFilterRepos(
      [
        { id: 'local-orca', displayName: 'orca', path: '/Users/me/orca', badgeColor: '#111111' },
        {
          id: 'm4-orca',
          displayName: 'orca',
          path: '/Users/m4air/orca/orca',
          executionHostId: 'runtime:m4air'
        },
        { id: 'assets', displayName: 'design-assets', path: '/Users/me/design-assets' },
        {
          id: 'local-orca',
          displayName: 'orca',
          path: '/srv/orca',
          executionHostId: 'runtime:other'
        }
      ],
      []
    )

    expect(repos.map(({ key, id, name }) => ({ key, id, name }))).toEqual([
      { key: 'local|local-orca', id: 'local-orca', name: 'orca' },
      { key: 'runtime:m4air|m4-orca', id: 'm4-orca', name: 'orca' },
      { key: 'local|assets', id: 'assets', name: 'design-assets' },
      { key: 'runtime:other|local-orca', id: 'local-orca', name: 'orca' }
    ])
    expect(repos[0]?.color).toBe('#111111')
  })

  it('lists the repos the rows name until a catalog answers, still one per repo id', () => {
    const repos = buildFilterRepos(
      [],
      [row('a', 'local-orca', 'local'), row('b', 'm4-orca', 'runtime:m4air')]
    )

    expect(repos.map((repo) => repo.id)).toEqual(['local-orca', 'm4-orca'])
  })

  it('filters by the picked repo id, leaving the same-named repo on another host out', () => {
    const rows = [row('a', 'local-orca', 'local'), row('b', 'm4-orca', 'runtime:m4air')]

    expect(
      filterWorktrees(rows, { ...NO_WORKSPACE_ROW_FILTERS, filterRepoIds: ['m4-orca'] }, '').map(
        (w) => w.worktreeId
      )
    ).toEqual(['b'])
  })
})

it('uses qualified tokens and durable offline scope in the catalog-less phone adapter', () => {
  const repos = buildFilterRepos(
    [
      { id: 'same', path: '/a', displayName: 'App' },
      { id: 'same', path: '/b', displayName: 'App', executionHostId: 'runtime:server' }
    ],
    []
  )
  const saved = ['runtime:server\0same', 'offline']
  expect(workspaceProjectFilterSelection(repos, saved)).toMatchObject({
    active: true,
    badgeCount: 1,
    matchingKeys: ['runtime:server|same'],
    unresolved: ['offline']
  })
  expect(
    filterWorktrees(
      [row('local', 'same', 'local'), row('remote', 'same', 'runtime:server')],
      { ...NO_WORKSPACE_ROW_FILTERS, filterRepoIds: saved },
      ''
    ).map((row) => row.worktreeId)
  ).toEqual(['remote'])
  expect(toggleProjectFilter(repos[1], saved, repos)).toEqual(['offline'])
  expect(workspaceProjectFilterSelection([], ['offline']).badgeCount).toBe(1)
})
