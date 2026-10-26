import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultOnboardingState } from '../../../../shared/onboarding-defaults'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { mergeDetectedWorktreesForHost } from '@/store/slices/worktrees/listing/detected-worktree-host-merge'
import type { RepoSlice } from '@/store/repos/repo-state'
import type { Repo } from '../../../../shared/repo-types'
import type {
  DetectedWorktree,
  DetectedWorktreeListResult,
  Worktree
} from '../../../../shared/worktree/types'
import {
  finishProjectAddWithDefaultCheckout,
  openProjectDefaultCheckout
} from './project-added-default-checkout'

const mocks = vi.hoisted(() => ({
  state: {
    activeRepoId: null as string | null,
    filterRepoIds: [] as string[],
    showActiveOnly: false,
    hideDefaultBranchWorkspace: false,
    repos: [] as Repo[],
    worktreesByRepo: {} as Record<string, Worktree[]>,
    detectedWorktreesByRepo: {} as Record<string, DetectedWorktreeListResult>,
    setActiveRepo: vi.fn(),
    setFilterRepoIds: vi.fn(),
    setShowActiveOnly: vi.fn(),
    setHideDefaultBranchWorkspace: vi.fn(),
    updateRepo: vi.fn(),
    fetchWorktrees: vi.fn()
  },
  activateAndRevealWorktree: vi.fn(),
  onboardingGet: vi.fn(),
  onboardingUpdate: vi.fn(),
  track: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mocks.state
  }
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))

vi.mock('@/lib/telemetry', () => ({
  track: mocks.track
}))

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'repo-1::/repo',
    repoId: 'repo-1',
    path: '/repo',
    displayName: 'main',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    head: 'abc',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: true,
    ...overrides
  }
}

function makeLinkedWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return makeWorktree({
    id: 'repo-1::/repo-feature',
    path: '/repo-feature',
    displayName: 'feature',
    branch: 'refs/heads/feature',
    isMainWorktree: false,
    ...overrides
  })
}

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/repo',
    displayName: 'repo',
    badgeColor: '#000000',
    addedAt: 0,
    ...overrides
  }
}

function makeDetectedLinkedWorktrees(
  defaultCheckout: Worktree,
  options: { linkedVisible?: boolean; linkedOwnership?: DetectedWorktree['ownership'] } = {}
): DetectedWorktreeListResult {
  const linkedVisible = options.linkedVisible ?? false
  return {
    repoId: 'repo-1',
    authoritative: true,
    source: 'git',
    worktrees: [
      {
        ...defaultCheckout,
        ownership: 'external',
        selectedCheckout: true,
        visible: true
      },
      {
        ...makeLinkedWorktree(),
        ownership: options.linkedOwnership ?? 'external',
        selectedCheckout: false,
        visible: linkedVisible
      }
    ]
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('finishProjectAddWithDefaultCheckout', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.state.activeRepoId = null
    mocks.state.filterRepoIds = []
    mocks.state.showActiveOnly = false
    mocks.state.hideDefaultBranchWorkspace = false
    mocks.state.repos = []
    mocks.state.worktreesByRepo = {}
    mocks.state.detectedWorktreesByRepo = {}
    mocks.state.updateRepo.mockImplementation(
      async (
        repoId: string,
        updates: Parameters<RepoSlice['updateRepo']>[1],
        options?: Parameters<RepoSlice['updateRepo']>[2]
      ) => {
        mocks.state.repos = mocks.state.repos.map((repo) => {
          if (repo.id !== repoId || getRepoExecutionHostId(repo) !== options?.hostId) {
            return repo
          }
          const applied = typeof updates === 'function' ? updates(repo) : updates
          return {
            ...repo,
            importedExternalWorktreePaths:
              applied.importedExternalWorktreePaths ?? repo.importedExternalWorktreePaths,
            externalWorktreeVisibilityPromptDismissedAt:
              applied.externalWorktreeVisibilityPromptDismissedAt ??
              repo.externalWorktreeVisibilityPromptDismissedAt
          }
        })
        return true
      }
    )
    mocks.state.fetchWorktrees.mockResolvedValue(true)
    mocks.onboardingGet.mockResolvedValue(getDefaultOnboardingState())
    mocks.onboardingUpdate.mockResolvedValue(getDefaultOnboardingState())
    vi.stubGlobal('window', {
      api: {
        onboarding: {
          get: mocks.onboardingGet,
          update: mocks.onboardingUpdate
        }
      }
    })
  })

  it('closes the modal and activates the default checkout', async () => {
    const closeModal = vi.fn()
    const setHideDefaultBranchWorkspace = vi.fn()
    mocks.state.hideDefaultBranchWorkspace = true
    mocks.state.worktreesByRepo = {
      'repo-1': [makeLinkedWorktree(), makeWorktree()]
    }

    await finishProjectAddWithDefaultCheckout({
      repoId: 'repo-1',
      source: 'clone_url',
      closeModal,
      setHideDefaultBranchWorkspace
    })

    expect(closeModal).toHaveBeenCalledTimes(1)
    expect(mocks.onboardingUpdate).toHaveBeenCalledWith({
      checklist: { addedRepo: true }
    })
    expect(setHideDefaultBranchWorkspace).toHaveBeenCalledWith(false)
    expect(mocks.track).toHaveBeenCalledWith('activation_checklist_item_completed', {
      item: 'addedRepo',
      time_since_completed_ms: 0
    })
    expect(mocks.track).toHaveBeenCalledWith('add_repo_default_checkout_handoff', {
      source: 'clone_url',
      result: 'opened_default_checkout',
      reason: 'loaded_default_checkout'
    })
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('repo-1::/repo')
  })

  it('activates only the captured host default checkout when repo IDs collide', async () => {
    const localMain = makeWorktree({
      id: 'repo-1::same-id',
      path: '/local/repo',
      hostId: 'local'
    })
    const runtimeMain = makeWorktree({
      id: 'repo-1::same-id',
      path: '/runtime/repo',
      hostId: 'runtime:env-1'
    })
    mocks.state.repos = [
      {
        id: 'repo-1',
        path: '/local/repo',
        displayName: 'local',
        badgeColor: '#111',
        addedAt: 1,
        executionHostId: 'local'
      },
      {
        id: 'repo-1',
        path: '/runtime/repo',
        displayName: 'runtime',
        badgeColor: '#222',
        addedAt: 2,
        executionHostId: 'runtime:env-1'
      }
    ]
    mocks.state.worktreesByRepo = {
      'repo-1': [localMain, runtimeMain]
    }

    await openProjectDefaultCheckout({
      repoId: 'repo-1',
      source: 'clone_url',
      executionHostId: 'runtime:env-1',
      setHideDefaultBranchWorkspace: vi.fn()
    })

    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith(runtimeMain.id, {
      executionHostId: 'runtime:env-1'
    })
  })

  it('opens the loaded owner checkout after another host makes merged detection authoritative', async () => {
    const localMain = makeWorktree({ hostId: 'local' })
    const sshMain = makeWorktree({ hostId: 'ssh:box', path: '/ssh/repo' })
    const failedLocal = mergeDetectedWorktreesForHost(
      makeDetectedLinkedWorktrees(localMain),
      { repoId: 'repo-1', authoritative: false, source: 'git', worktrees: [] },
      'local'
    )
    mocks.state.detectedWorktreesByRepo = {
      'repo-1': mergeDetectedWorktreesForHost(
        failedLocal,
        {
          repoId: 'repo-1',
          authoritative: true,
          source: 'git',
          worktrees: [{ ...sshMain, ownership: 'external', selectedCheckout: true, visible: true }]
        },
        'ssh:box'
      )
    }
    mocks.state.repos = [makeRepo(), makeRepo({ executionHostId: 'ssh:box', path: '/ssh/repo' })]
    mocks.state.worktreesByRepo = { 'repo-1': [localMain] }

    await openProjectDefaultCheckout({
      repoId: 'repo-1',
      source: 'local_folder_picker',
      executionHostId: 'local',
      setHideDefaultBranchWorkspace: vi.fn()
    })

    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledExactlyOnceWith(localMain.id, {
      executionHostId: 'local'
    })
    expect(mocks.state.updateRepo).not.toHaveBeenCalled()
  })

  it('activates a runtime-owned checkout even when its physical host is private SSH', async () => {
    const runtimeMain = makeWorktree({
      id: 'repo-1::runtime-ssh',
      hostId: 'ssh:private-target',
      runtimeOwnerEnvironmentId: 'env-1'
    })
    mocks.state.worktreesByRepo = { 'repo-1': [runtimeMain] }

    await openProjectDefaultCheckout({
      repoId: 'repo-1',
      source: 'runtime_server_path',
      executionHostId: 'runtime:env-1',
      setHideDefaultBranchWorkspace: vi.fn()
    })

    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith(runtimeMain.id, {
      executionHostId: 'runtime:env-1'
    })
  })

  it.each(['ssh:box', 'runtime:env-1'] as const)(
    'opens an older unstamped checkout belonging to the sole %s repo owner',
    async (executionHostId) => {
      mocks.state.repos = [makeRepo({ executionHostId })]
      mocks.state.worktreesByRepo = { 'repo-1': [makeWorktree()] }

      await openProjectDefaultCheckout({
        repoId: 'repo-1',
        source: 'project_added_compat',
        executionHostId,
        setHideDefaultBranchWorkspace: vi.fn()
      })

      expect(mocks.activateAndRevealWorktree).toHaveBeenCalledExactlyOnceWith('repo-1::/repo', {
        executionHostId
      })
    }
  )

  it('uses the sole repo owner for activation when the caller omits its host', async () => {
    mocks.state.repos = [makeRepo({ executionHostId: 'ssh:box' })]
    mocks.state.worktreesByRepo = { 'repo-1': [makeWorktree({ hostId: 'ssh:box' })] }

    await openProjectDefaultCheckout({
      repoId: 'repo-1',
      source: 'project_added_compat',
      setHideDefaultBranchWorkspace: vi.fn()
    })

    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledExactlyOnceWith('repo-1::/repo', {
      executionHostId: 'ssh:box'
    })
  })

  it('does not activate a loaded checkout when its bare repo ID has multiple owners', async () => {
    mocks.state.repos = [makeRepo(), makeRepo({ executionHostId: 'ssh:box' })]
    mocks.state.worktreesByRepo = {
      'repo-1': [makeWorktree({ hostId: 'local' }), makeWorktree({ hostId: 'ssh:box' })]
    }

    await openProjectDefaultCheckout({
      repoId: 'repo-1',
      source: 'project_added_compat',
      setHideDefaultBranchWorkspace: vi.fn()
    })

    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(mocks.state.updateRepo).not.toHaveBeenCalled()
  })

  it('passes a contained selected path through as the initial terminal cwd', async () => {
    mocks.state.worktreesByRepo = {
      'repo-1': [makeWorktree()]
    }

    await openProjectDefaultCheckout({
      repoId: 'repo-1',
      source: 'local_folder_picker',
      selectedPath: '/repo/packages/web',
      setHideDefaultBranchWorkspace: vi.fn()
    })

    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('repo-1::/repo', {
      initialCwd: '/repo/packages/web'
    })
  })

  it('skips the initial cwd override when the selected path is the repo root', async () => {
    mocks.state.worktreesByRepo = {
      'repo-1': [makeWorktree()]
    }

    await openProjectDefaultCheckout({
      repoId: 'repo-1',
      source: 'local_folder_picker',
      selectedPath: '/repo',
      setHideDefaultBranchWorkspace: vi.fn()
    })

    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('repo-1::/repo')
  })

  it('imports only a hidden detected default checkout before activating it', async () => {
    const defaultCheckout = makeWorktree()
    mocks.state.repos = [makeRepo({ importedExternalWorktreePaths: ['/already-imported'] })]
    mocks.state.detectedWorktreesByRepo = {
      'repo-1': {
        repoId: 'repo-1',
        authoritative: true,
        source: 'git',
        worktrees: [
          {
            ...defaultCheckout,
            ownership: 'external',
            selectedCheckout: false,
            visible: false
          }
        ]
      }
    }
    mocks.state.fetchWorktrees.mockImplementation(async () => {
      mocks.state.worktreesByRepo = {
        'repo-1': [defaultCheckout]
      }
      mocks.state.detectedWorktreesByRepo = {
        'repo-1': {
          repoId: 'repo-1',
          authoritative: true,
          source: 'git',
          worktrees: [
            { ...defaultCheckout, ownership: 'external', selectedCheckout: false, visible: true }
          ]
        }
      }
      return true
    })

    await openProjectDefaultCheckout({
      repoId: 'repo-1',
      source: 'local_folder_picker',
      setHideDefaultBranchWorkspace: vi.fn()
    })

    expect(mocks.state.updateRepo).toHaveBeenCalledExactlyOnceWith('repo-1', expect.any(Function), {
      hostId: 'local'
    })
    expect(mocks.state.repos[0]?.importedExternalWorktreePaths).toEqual([
      '/already-imported',
      '/repo'
    ])
    expect(mocks.state.fetchWorktrees).toHaveBeenCalledWith('repo-1', {
      requireAuthoritative: true,
      executionHostId: 'local'
    })
    expect(mocks.track).toHaveBeenCalledWith('add_repo_default_checkout_handoff', {
      source: 'local_folder_picker',
      result: 'opened_default_checkout',
      reason: 'detected_default_checkout'
    })
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('repo-1::/repo', {
      executionHostId: 'local'
    })
  })

  it('merges imports from the host row updateRepo writes when repo IDs collide', async () => {
    const sshCheckout = makeWorktree({ hostId: 'ssh:box' })
    mocks.state.repos = [
      makeRepo({ executionHostId: 'local', importedExternalWorktreePaths: ['/local-only'] }),
      makeRepo({ executionHostId: 'ssh:box', importedExternalWorktreePaths: ['/ssh-only'] })
    ]
    mocks.state.detectedWorktreesByRepo = {
      'repo-1': {
        repoId: 'repo-1',
        authoritative: true,
        source: 'git',
        worktrees: [
          { ...sshCheckout, ownership: 'external', selectedCheckout: false, visible: false }
        ]
      }
    }
    mocks.state.fetchWorktrees.mockImplementation(async () => {
      mocks.state.worktreesByRepo = { 'repo-1': [sshCheckout] }
      mocks.state.detectedWorktreesByRepo = {
        'repo-1': {
          repoId: 'repo-1',
          authoritative: true,
          source: 'git',
          worktrees: [
            { ...sshCheckout, ownership: 'external', selectedCheckout: false, visible: true }
          ]
        }
      }
      return true
    })

    await openProjectDefaultCheckout({
      repoId: 'repo-1',
      source: 'ssh_remote_path',
      executionHostId: 'ssh:box',
      setHideDefaultBranchWorkspace: vi.fn()
    })

    expect(mocks.state.updateRepo).toHaveBeenCalledExactlyOnceWith('repo-1', expect.any(Function), {
      hostId: 'ssh:box'
    })
    expect(mocks.state.repos.map((repo) => repo.importedExternalWorktreePaths)).toEqual([
      ['/local-only'],
      ['/ssh-only', '/repo']
    ])
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith(sshCheckout.id, {
      executionHostId: 'ssh:box'
    })
  })

  it('does not guess which host owns a bare repo ID shared across hosts', async () => {
    const defaultCheckout = makeWorktree()
    mocks.state.repos = [
      makeRepo({ executionHostId: 'local', importedExternalWorktreePaths: ['/local-only'] }),
      makeRepo({ executionHostId: 'ssh:box', importedExternalWorktreePaths: ['/ssh-only'] })
    ]
    mocks.state.detectedWorktreesByRepo = {
      'repo-1': {
        repoId: 'repo-1',
        authoritative: true,
        source: 'git',
        worktrees: [
          { ...defaultCheckout, ownership: 'external', selectedCheckout: false, visible: false }
        ]
      }
    }

    await openProjectDefaultCheckout({
      repoId: 'repo-1',
      source: 'project_added_compat',
      setHideDefaultBranchWorkspace: vi.fn()
    })

    expect(mocks.state.updateRepo).not.toHaveBeenCalled()
    expect(mocks.track).toHaveBeenCalledWith('add_repo_default_checkout_handoff', {
      source: 'project_added_compat',
      result: 'revealed_project',
      reason: 'no_default_checkout'
    })
  })

  it('keeps hidden sibling worktrees hidden behind the hidden-worktrees hint', async () => {
    const defaultCheckout = makeWorktree()
    mocks.state.repos = [makeRepo()]
    mocks.state.worktreesByRepo = {
      'repo-1': [defaultCheckout]
    }
    mocks.state.detectedWorktreesByRepo = {
      'repo-1': makeDetectedLinkedWorktrees(defaultCheckout)
    }

    await openProjectDefaultCheckout({
      repoId: 'repo-1',
      source: 'local_folder_picker',
      setHideDefaultBranchWorkspace: vi.fn()
    })

    // Resolving the initial prompt routes the repo to the compact hint instead of revealing siblings.
    expect(mocks.state.updateRepo).toHaveBeenCalledExactlyOnceWith('repo-1', expect.any(Function), {
      hostId: 'local'
    })
    expect(mocks.state.repos[0]?.externalWorktreeVisibilityPromptDismissedAt).toEqual(
      expect.any(Number)
    )
    expect(mocks.state.fetchWorktrees).not.toHaveBeenCalled()
    expect(mocks.track).toHaveBeenCalledWith('add_repo_default_checkout_handoff', {
      source: 'local_folder_picker',
      result: 'opened_default_checkout',
      reason: 'loaded_default_checkout'
    })
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('repo-1::/repo', {
      executionHostId: 'local'
    })
  })

  it('leaves an already-resolved visibility prompt alone', async () => {
    const defaultCheckout = makeWorktree()
    mocks.state.repos = [makeRepo({ externalWorktreeVisibilityPromptDismissedAt: 1 })]
    mocks.state.worktreesByRepo = { 'repo-1': [defaultCheckout] }
    mocks.state.detectedWorktreesByRepo = {
      'repo-1': makeDetectedLinkedWorktrees(defaultCheckout)
    }

    await openProjectDefaultCheckout({
      repoId: 'repo-1',
      source: 'local_folder_picker',
      setHideDefaultBranchWorkspace: vi.fn()
    })

    expect(mocks.state.updateRepo).not.toHaveBeenCalled()
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('repo-1::/repo', {
      executionHostId: 'local'
    })
  })

  it('still opens the checkout when resolving the visibility prompt fails', async () => {
    const defaultCheckout = makeWorktree()
    mocks.state.repos = [makeRepo()]
    mocks.state.worktreesByRepo = { 'repo-1': [defaultCheckout] }
    mocks.state.detectedWorktreesByRepo = {
      'repo-1': makeDetectedLinkedWorktrees(defaultCheckout)
    }
    mocks.state.updateRepo.mockResolvedValue(false)

    await openProjectDefaultCheckout({
      repoId: 'repo-1',
      source: 'local_folder_picker',
      setHideDefaultBranchWorkspace: vi.fn()
    })

    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('repo-1::/repo', {
      executionHostId: 'local'
    })
  })

  it('does not refresh already-visible sibling external worktrees', async () => {
    const defaultCheckout = makeWorktree()
    mocks.state.repos = [makeRepo()]
    mocks.state.worktreesByRepo = {
      'repo-1': [defaultCheckout]
    }
    mocks.state.detectedWorktreesByRepo = {
      'repo-1': makeDetectedLinkedWorktrees(defaultCheckout, { linkedVisible: true })
    }

    await openProjectDefaultCheckout({
      repoId: 'repo-1',
      source: 'local_folder_picker',
      setHideDefaultBranchWorkspace: vi.fn()
    })

    expect(mocks.state.updateRepo).not.toHaveBeenCalled()
    expect(mocks.state.fetchWorktrees).not.toHaveBeenCalled()
    expect(mocks.track).toHaveBeenCalledWith('add_repo_default_checkout_handoff', {
      source: 'local_folder_picker',
      result: 'opened_default_checkout',
      reason: 'loaded_default_checkout'
    })
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('repo-1::/repo', {
      executionHostId: 'local'
    })
  })

  it('does not raise the hint when the only hidden siblings are agent scratch', async () => {
    const defaultCheckout = makeWorktree()
    mocks.state.repos = [makeRepo()]
    mocks.state.worktreesByRepo = {
      'repo-1': [defaultCheckout]
    }
    mocks.state.detectedWorktreesByRepo = {
      'repo-1': makeDetectedLinkedWorktrees(defaultCheckout, { linkedOwnership: 'agent-scratch' })
    }

    await openProjectDefaultCheckout({
      repoId: 'repo-1',
      source: 'local_folder_picker',
      setHideDefaultBranchWorkspace: vi.fn()
    })

    expect(mocks.state.updateRepo).not.toHaveBeenCalled()
    expect(mocks.state.fetchWorktrees).not.toHaveBeenCalled()
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('repo-1::/repo', {
      executionHostId: 'local'
    })
  })

  it('opens the picked linked checkout instead of the loaded primary', async () => {
    const setHideDefaultBranchWorkspace = vi.fn()
    mocks.state.hideDefaultBranchWorkspace = true
    const primary = makeWorktree()
    const linked = makeLinkedWorktree()
    mocks.state.repos = [makeRepo()]
    mocks.state.worktreesByRepo = { 'repo-1': [primary, linked] }

    await openProjectDefaultCheckout({
      repoId: 'repo-1',
      source: 'local_folder_picker',
      selectedPath: '/repo-feature/packages/web',
      setHideDefaultBranchWorkspace
    })

    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith(linked.id, {
      initialCwd: '/repo-feature/packages/web',
      executionHostId: 'local'
    })
    // Only the primary is a default-branch workspace, so the user's filter stays as-is.
    expect(setHideDefaultBranchWorkspace).not.toHaveBeenCalled()
    expect(mocks.track).toHaveBeenCalledWith('add_repo_default_checkout_handoff', {
      source: 'local_folder_picker',
      result: 'opened_selected_checkout',
      reason: 'loaded_default_checkout'
    })
  })

  it.each([
    ['/repo', '/repo/.worktrees/feat', '/repo/.worktrees/feat'],
    ['C:\\Repo', 'c:/repo/.worktrees/feat', 'C:\\REPO\\.worktrees\\feat'],
    ['//wsl.localhost/Ubuntu/r', '//wsl$/ubuntu/r/f', '//wsl.localhost/Ubuntu/r/f']
  ])(
    'opens the nested checkout inside %s using path containment',
    async (primaryPath, linkedPath, selectedPath) => {
      const primary = makeWorktree({ path: primaryPath })
      const nested = makeLinkedWorktree({ path: linkedPath })
      mocks.state.repos = [makeRepo({ path: primaryPath })]
      mocks.state.worktreesByRepo = { 'repo-1': [nested, primary] }

      await openProjectDefaultCheckout({
        repoId: 'repo-1',
        source: 'local_folder_picker',
        selectedPath,
        setHideDefaultBranchWorkspace: vi.fn()
      })

      expect(mocks.activateAndRevealWorktree).toHaveBeenCalledExactlyOnceWith(nested.id, {
        executionHostId: 'local'
      })
    }
  )

  it('imports a hidden picked checkout without revealing its siblings', async () => {
    const primary = makeWorktree()
    const linked = makeLinkedWorktree()
    mocks.state.repos = [makeRepo()]
    mocks.state.worktreesByRepo = { 'repo-1': [primary] }
    const detectedBeforeImport = makeDetectedLinkedWorktrees(primary)
    const sibling: DetectedWorktree = {
      ...makeLinkedWorktree({ id: 'repo-1::/another', path: '/another' }),
      ownership: 'external',
      selectedCheckout: false,
      visible: false
    }
    detectedBeforeImport.worktrees.push(sibling)
    mocks.state.detectedWorktreesByRepo = { 'repo-1': detectedBeforeImport }
    mocks.state.fetchWorktrees.mockImplementation(async () => {
      mocks.state.worktreesByRepo = { 'repo-1': [primary, linked] }
      mocks.state.detectedWorktreesByRepo = {
        'repo-1': {
          ...makeDetectedLinkedWorktrees(primary, { linkedVisible: true }),
          worktrees: detectedBeforeImport.worktrees.map((worktree) =>
            worktree.id === linked.id ? { ...worktree, visible: true } : worktree
          )
        }
      }
      return true
    })

    await openProjectDefaultCheckout({
      repoId: 'repo-1',
      source: 'local_folder_picker',
      selectedPath: '/repo-feature',
      setHideDefaultBranchWorkspace: vi.fn()
    })

    expect(mocks.state.updateRepo).toHaveBeenCalledExactlyOnceWith('repo-1', expect.any(Function), {
      hostId: 'local'
    })
    expect(mocks.state.repos[0]?.importedExternalWorktreePaths).toEqual(['/repo-feature'])
    expect(mocks.state.repos[0]?.externalWorktreeVisibilityPromptDismissedAt).toEqual(
      expect.any(Number)
    )
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith(linked.id, {
      executionHostId: 'local'
    })
    expect(mocks.track).toHaveBeenCalledWith('add_repo_default_checkout_handoff', {
      source: 'local_folder_picker',
      result: 'opened_selected_checkout',
      reason: 'detected_default_checkout'
    })
  })

  it('reopens the linked checkout a project is registered at instead of its hidden primary', async () => {
    const primary = makeWorktree()
    const linked = makeLinkedWorktree()
    mocks.state.repos = [makeRepo({ path: '/repo-feature' })]
    mocks.state.worktreesByRepo = { 'repo-1': [linked] }
    mocks.state.detectedWorktreesByRepo = {
      'repo-1': {
        repoId: 'repo-1',
        authoritative: true,
        source: 'git',
        worktrees: [
          { ...primary, ownership: 'external', selectedCheckout: false, visible: false },
          { ...linked, ownership: 'external', selectedCheckout: true, visible: true }
        ]
      }
    }

    await openProjectDefaultCheckout({
      repoId: 'repo-1',
      source: 'project_added_compat',
      setHideDefaultBranchWorkspace: vi.fn()
    })

    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith(linked.id, {
      executionHostId: 'local'
    })
    // The hidden primary is a sibling like any other, so it stays hidden behind the hint.
    expect(mocks.state.updateRepo).toHaveBeenCalledExactlyOnceWith('repo-1', expect.any(Function), {
      hostId: 'local'
    })
    expect(mocks.state.repos[0]?.externalWorktreeVisibilityPromptDismissedAt).toEqual(
      expect.any(Number)
    )
    expect(mocks.state.fetchWorktrees).not.toHaveBeenCalled()
  })

  it('reveals the project if no default checkout is available', async () => {
    const closeModal = vi.fn()
    const setHideDefaultBranchWorkspace = vi.fn()
    mocks.state.worktreesByRepo = {
      'repo-1': [makeWorktree({ isMainWorktree: false })]
    }

    await finishProjectAddWithDefaultCheckout({
      repoId: 'repo-1',
      source: 'ssh_remote_path',
      closeModal,
      setHideDefaultBranchWorkspace
    })

    expect(closeModal).toHaveBeenCalledTimes(1)
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(mocks.track).toHaveBeenCalledWith('add_repo_default_checkout_handoff', {
      source: 'ssh_remote_path',
      result: 'revealed_project',
      reason: 'no_authoritative_detection'
    })
    expect(mocks.state.setActiveRepo).toHaveBeenCalledWith('repo-1')
    expect(setHideDefaultBranchWorkspace).not.toHaveBeenCalled()
  })

  it('reveals the project even when no worktrees are loaded', async () => {
    mocks.state.activeRepoId = 'repo-2'
    mocks.state.filterRepoIds = ['repo-2']
    mocks.state.showActiveOnly = true

    await openProjectDefaultCheckout({
      repoId: 'repo-1',
      source: 'project_added_compat',
      setHideDefaultBranchWorkspace: vi.fn()
    })

    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(mocks.track).toHaveBeenCalledWith('add_repo_default_checkout_handoff', {
      source: 'project_added_compat',
      result: 'revealed_project',
      reason: 'no_authoritative_detection'
    })
    expect(mocks.state.setActiveRepo).toHaveBeenCalledWith('repo-1')
    expect(mocks.state.setFilterRepoIds).toHaveBeenCalledWith(['repo-2', 'repo-1'])
    expect(mocks.state.setShowActiveOnly).toHaveBeenCalledWith(false)
  })
})
