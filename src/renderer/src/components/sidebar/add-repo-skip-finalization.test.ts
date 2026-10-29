import { describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { getProjectGroupingIndexFromState } from '../../store/project-host-setup-selector'
import { projectRepoFilterMatcher } from '../../../../shared/project-grouping'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  finalizeImportedRepoAfterSkip,
  type AddRepoSkipFinalizationState
} from './add-repo-skip-finalization'

function makeWorktree(overrides: Partial<Worktree> & { id: string; repoId: string }): Worktree {
  return {
    path: `/tmp/${overrides.id}`,
    head: 'abc123',
    branch: 'refs/heads/feature',
    isBare: false,
    isMainWorktree: false,
    displayName: overrides.id,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

function makeState(overrides: Partial<AddRepoSkipFinalizationState>): AddRepoSkipFinalizationState {
  return {
    activeRepoId: null,
    filterRepoIds: [],
    showActiveOnly: false,
    hideDefaultBranchWorkspace: false,
    showSleepingWorkspaces: true,
    alwaysShowDefaultBranchWorkspace: true,
    repos: [],
    worktreesByRepo: {},
    setActiveRepo: vi.fn(),
    setFilterRepoIds: vi.fn(),
    setShowActiveOnly: vi.fn(),
    setHideDefaultBranchWorkspace: vi.fn(),
    setAlwaysShowDefaultBranchWorkspace: vi.fn(),
    ...overrides
  }
}

describe('finalizeImportedRepoAfterSkip', () => {
  it('keeps skipped imported worktrees visible without activating a worktree', () => {
    const state = makeState({
      activeRepoId: 'repo-old',
      filterRepoIds: ['repo-old'],
      showActiveOnly: true,
      hideDefaultBranchWorkspace: false,
      worktreesByRepo: {
        'repo-new': [makeWorktree({ id: 'repo-new::/repo/feature', repoId: 'repo-new' })]
      }
    })

    finalizeImportedRepoAfterSkip(state, 'repo-new')

    expect(state.setActiveRepo).toHaveBeenCalledWith('repo-new')
    expect(state.setFilterRepoIds).toHaveBeenCalledWith(['repo-old', 'local\0repo-new'])
    expect(state.setShowActiveOnly).toHaveBeenCalledWith(false)
    expect(state.setHideDefaultBranchWorkspace).not.toHaveBeenCalled()
  })

  it.each(['repository', 'host', 'folder'] as const)(
    'reveals the imported logical group without losing offline scope in %s mode',
    (projectGroupingMode) => {
      const repos: Repo[] = [
        {
          id: 'first',
          path: '/app',
          displayName: 'App',
          badgeColor: '',
          addedAt: 0,
          upstream: { owner: 'org', repo: 'app' }
        },
        {
          id: 'second',
          path: '/app-copy',
          displayName: 'App',
          badgeColor: '',
          addedAt: 0,
          upstream: { owner: 'org', repo: 'app' }
        },
        {
          id: 'remote',
          path: '/remote/app',
          displayName: 'App',
          badgeColor: '',
          addedAt: 0,
          upstream: { owner: 'org', repo: 'app' },
          executionHostId: 'runtime:remote'
        }
      ]
      const grouping = getProjectGroupingIndexFromState({
        repos,
        settings: { ...getDefaultSettings('/home/test'), projectGroupingMode }
      })
      const state = makeState({ repos, filterRepoIds: ['offline', 'runtime:offline\0gone'] })
      finalizeImportedRepoAfterSkip(state, 'second', grouping)
      const selection = vi.mocked(state.setFilterRepoIds).mock.calls[0][0]
      expect(selection).toEqual(expect.arrayContaining(['offline', 'runtime:offline\0gone']))
      const matches = projectRepoFilterMatcher(selection)
      expect(
        repos
          .filter((repo) => matches(repo.id, repo.executionHostId ?? 'local'))
          .map((repo) => repo.id)
      ).toEqual(
        projectGroupingMode === 'repository'
          ? ['first', 'second', 'remote']
          : projectGroupingMode === 'host'
            ? ['first', 'second']
            : ['second']
      )
      expect(state.setActiveRepo).toHaveBeenCalledWith('second')
    }
  )

  it('leaves the project filter off when the import lands with no filter', () => {
    const state = makeState({ filterRepoIds: [] })

    finalizeImportedRepoAfterSkip(state, 'repo-new')

    expect(state.setFilterRepoIds).not.toHaveBeenCalled()
  })

  it('clears default-branch hiding when it would hide every imported worktree', () => {
    const state = makeState({
      hideDefaultBranchWorkspace: true,
      worktreesByRepo: {
        'repo-new': [
          makeWorktree({
            id: 'repo-new::/repo/main',
            repoId: 'repo-new',
            isMainWorktree: true,
            branch: 'refs/heads/main'
          })
        ]
      }
    })

    finalizeImportedRepoAfterSkip(state, 'repo-new')

    expect(state.setHideDefaultBranchWorkspace).toHaveBeenCalledWith(false)
  })

  it('clears default-branch hiding for a folder project whose only row is its root', () => {
    const state = makeState({
      hideDefaultBranchWorkspace: true,
      repos: [{ id: 'folder-new', kind: 'folder' }],
      worktreesByRepo: {
        'folder-new': [
          makeWorktree({
            id: 'folder-new::/notes',
            repoId: 'folder-new',
            isMainWorktree: true,
            head: '',
            branch: ''
          })
        ]
      }
    })

    finalizeImportedRepoAfterSkip(state, 'folder-new')

    expect(state.setHideDefaultBranchWorkspace).toHaveBeenCalledWith(false)
  })

  it.each([false, true])(
    'ignores archived siblings when revealing a folder root after Skip (root archived: %s)',
    (rootArchived) => {
      const state = makeState({
        hideDefaultBranchWorkspace: true,
        showSleepingWorkspaces: false,
        alwaysShowDefaultBranchWorkspace: false,
        repos: [{ id: 'folder-new', kind: 'folder' }],
        worktreesByRepo: {
          'folder-new': [
            makeWorktree({
              id: 'folder-new::/notes',
              repoId: 'folder-new',
              isMainWorktree: true,
              head: '',
              branch: '',
              isArchived: rootArchived
            }),
            makeWorktree({
              id: 'folder-new::/notes::workspace:archived',
              repoId: 'folder-new',
              head: '',
              branch: '',
              isArchived: true
            })
          ]
        }
      })

      finalizeImportedRepoAfterSkip(state, 'folder-new')

      if (rootArchived) {
        expect(state.setHideDefaultBranchWorkspace).not.toHaveBeenCalled()
        expect(state.setAlwaysShowDefaultBranchWorkspace).not.toHaveBeenCalled()
      } else {
        expect(state.setHideDefaultBranchWorkspace).toHaveBeenCalledWith(false)
        expect(state.setAlwaysShowDefaultBranchWorkspace).toHaveBeenCalledWith(true)
      }
    }
  )

  it('re-enables the default-branch exemption when the import would land asleep and hidden', () => {
    const state = makeState({
      showSleepingWorkspaces: false,
      alwaysShowDefaultBranchWorkspace: false,
      worktreesByRepo: {
        'repo-new': [
          makeWorktree({
            id: 'repo-new::/repo/main',
            repoId: 'repo-new',
            isMainWorktree: true,
            branch: 'refs/heads/main'
          })
        ]
      }
    })

    finalizeImportedRepoAfterSkip(state, 'repo-new')

    expect(state.setAlwaysShowDefaultBranchWorkspace).toHaveBeenCalledWith(true)
  })

  it('leaves the default-branch exemption alone when sleeping workspaces are shown', () => {
    const state = makeState({
      showSleepingWorkspaces: true,
      alwaysShowDefaultBranchWorkspace: false,
      worktreesByRepo: {
        'repo-new': [
          makeWorktree({
            id: 'repo-new::/repo/main',
            repoId: 'repo-new',
            isMainWorktree: true,
            branch: 'refs/heads/main'
          })
        ]
      }
    })

    finalizeImportedRepoAfterSkip(state, 'repo-new')

    expect(state.setAlwaysShowDefaultBranchWorkspace).not.toHaveBeenCalled()
  })

  it('still reveals the imported repo when it has no discovered worktrees yet', () => {
    const state = makeState({
      activeRepoId: 'repo-old',
      filterRepoIds: ['repo-old'],
      showActiveOnly: true,
      hideDefaultBranchWorkspace: true,
      worktreesByRepo: { 'repo-new': [] }
    })

    finalizeImportedRepoAfterSkip(state, 'repo-new')

    expect(state.setActiveRepo).toHaveBeenCalledWith('repo-new')
    expect(state.setFilterRepoIds).toHaveBeenCalledWith(['repo-old', 'local\0repo-new'])
    expect(state.setShowActiveOnly).toHaveBeenCalledWith(false)
    expect(state.setHideDefaultBranchWorkspace).not.toHaveBeenCalled()
  })
})
