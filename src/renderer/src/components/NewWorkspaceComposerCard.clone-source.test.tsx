// @vitest-environment happy-dom
import { act, cleanup, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { renderCard, unmountCard } from './NewWorkspaceComposerCard.test-fixture'
import { useAppStore } from '@/store'
import { getProjectGroupingIndexFromState } from '@/store/project-host-setup-selector'
import { projectHostSetupProjectionFromRepos } from '../../../shared/project-host-setup-projection'
import type { Repo } from '../../../shared/repo-types'
import { buildNewWorkspaceProjectOptions } from '@/lib/new-workspace-project-options'

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))
vi.mock('@/components/contextual-tours/use-contextual-tour', () => ({
  useContextualTour: () => {}
}))
vi.mock('@/components/agent/AgentCombobox', () => ({ default: () => null }))
vi.mock('@/components/sidebar/AddRemoteHostDialog', () => ({ AddRemoteHostDialog: () => null }))
vi.mock('@/components/sparse/SparseCheckoutPresetSelect', () => ({ default: () => null }))
vi.mock('@/components/new-workspace/SmartWorkspaceNameField', () => ({
  default: () => <input aria-label="workspace name" />
}))
let container: HTMLDivElement | null = null
afterEach(() => {
  if (container) {
    unmountCard(container)
    container = null
  }
  cleanup()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

it.each(['repository', 'host', 'folder'] as const)(
  'clones the contextual second server checkout through real Project/Run-on/location controls in %s mode',
  async (mode) => {
    const local: Repo = {
      id: 'same',
      path: '/local/app',
      displayName: 'App',
      badgeColor: '',
      addedAt: 0,
      upstream: { owner: 'org', repo: 'app' },
      gitRemoteIdentity: {
        canonicalKey: 'github.com/local/app',
        remoteName: 'origin',
        remoteUrl: 'https://github.com/local/app.git'
      }
    }
    const server: Repo = {
      ...local,
      path: '/server/app',
      executionHostId: 'runtime:server',
      gitRemoteIdentity: {
        canonicalKey: 'github.com/server/app',
        remoteName: 'origin',
        remoteUrl: 'https://github.com/server/app.git'
      }
    }
    const second: Repo = {
      ...server,
      id: 'second',
      path: '/server/second',
      gitRemoteIdentity: {
        canonicalKey: 'github.com/second/app',
        remoteName: 'origin',
        remoteUrl: 'https://github.com/second/app.git'
      }
    }
    const repos = [local, server, second]
    const projection = projectHostSetupProjectionFromRepos(repos)
    const clone = vi.fn().mockResolvedValue({ setup: { id: 'cloned' } })
    useAppStore.setState({
      repos,
      projects: projection.projects,
      projectHostSetups: projection.setups,
      settings: { ...useAppStore.getState().settings!, projectGroupingMode: mode },
      setupProjectClone: clone
    })
    const index = getProjectGroupingIndexFromState(useAppStore.getState())
    const group = index.groupByRepoHost.get('runtime:server\0second')!
    const options = buildNewWorkspaceProjectOptions({
      projects: projection.projects,
      projectHostSetups: projection.setups,
      eligibleRepos: repos,
      grouping: index
    })
    const ready = vi.fn()
    container = await renderCard({
      eligibleRepos: repos,
      projectOptions: options,
      selectedProjectId: group.key,
      repoId: second.id,
      selectedRepo: second,
      selectedRepoPath: second.path,
      selectedRepoExecutionHostId: second.executionHostId,
      projectHostSetupOptions: [
        {
          kind: 'needs-setup',
          id: 'destination',
          projectId: group.representative.projectId,
          hostId: 'runtime:destination',
          label: 'Destination',
          detail: 'Project location not set',
          isAvailable: true,
          attention: false,
          canSetLocation: true
        }
      ],
      selectedProjectHostSetupId: null,
      onProjectHostSetupChange: ready
    })
    const user = userEvent.setup()
    await user.click(container.querySelector<HTMLElement>('[data-run-target-combobox-root]')!)
    await user.click(screen.getByRole('button', { name: /Set project location/ }))
    await user.click(await screen.findByRole('button', { name: /Clone from URL/ }))
    await user.type(screen.getByPlaceholderText('/destination/on/host'), '/destination/new-app')
    await user.click(screen.getByRole('button', { name: 'Clone' }))
    expect(clone).toHaveBeenCalledExactlyOnceWith({
      projectId: group.representative.projectId,
      hostId: 'runtime:destination',
      url: 'https://github.com/second/app.git',
      destination: '/destination/new-app',
      displayName: group.label
    })
    expect(ready).toHaveBeenCalledWith(JSON.stringify(['cloned', 'runtime:destination']))
  }
)

it('re-derives an untouched restored source, preserves edits through catalog changes, and fences fresh-source/dismissed requests', async () => {
  const source: Repo = {
    id: 'same',
    path: '/server/app',
    executionHostId: 'runtime:server',
    displayName: 'App',
    badgeColor: '',
    addedAt: 0,
    upstream: { owner: 'org', repo: 'app' }
  }
  const other: Repo = {
    ...source,
    id: 'second',
    path: '/server/second',
    gitRemoteIdentity: {
      canonicalKey: 'github.com/second/app',
      remoteName: 'origin',
      remoteUrl: 'https://github.com/second/app.git'
    }
  }
  const projection = projectHostSetupProjectionFromRepos([source, other])
  let finish!: (result: { setup: { id: string } }) => void
  const clone = vi.fn(
    () =>
      new Promise<{ setup: { id: string } }>((resolve) => {
        finish = resolve
      })
  )
  const ready = vi.fn()
  useAppStore.setState({
    repos: [source, other],
    projects: projection.projects,
    projectHostSetups: projection.setups,
    setupProjectClone: clone
  })
  const index = getProjectGroupingIndexFromState(useAppStore.getState())
  const group = index.groupByRepoHost.get('runtime:server\0same')!
  const options = buildNewWorkspaceProjectOptions({
    projects: projection.projects,
    projectHostSetups: projection.setups,
    eligibleRepos: [source, other],
    grouping: index
  })
  const props = {
    eligibleRepos: [source, other],
    projectOptions: options,
    selectedProjectId: group.key,
    repoId: source.id,
    selectedRepo: source,
    selectedRepoPath: source.path,
    selectedRepoExecutionHostId: source.executionHostId,
    projectHostSetupOptions: [
      {
        kind: 'needs-setup' as const,
        id: 'destination',
        projectId: group.representative.projectId,
        hostId: 'runtime:destination' as const,
        label: 'Destination',
        detail: 'Project location not set',
        isAvailable: true,
        attention: false,
        canSetLocation: true
      }
    ],
    selectedProjectHostSetupId: null,
    onProjectHostSetupChange: ready
  }
  container = await renderCard(props)
  const user = userEvent.setup()
  const open = async () => {
    await user.click(container!.querySelector<HTMLElement>('[data-run-target-combobox-root]')!)
    await user.click(screen.getByRole('button', { name: /Set project location/ }))
    await user.click(await screen.findByRole('button', { name: /Clone from URL/ }))
  }
  await open()
  const input = screen.getByPlaceholderText('Repository URL')
  if (!(input instanceof HTMLInputElement)) {
    throw new Error('Missing URL input')
  }
  expect(input.value).toBe('')
  const hydrated = {
    ...source,
    gitRemoteIdentity: {
      canonicalKey: 'github.com/first/app',
      remoteName: 'origin',
      remoteUrl: 'https://github.com/first/app.git'
    }
  }
  act(() => useAppStore.setState({ repos: [other, hydrated] }))
  expect(input.value).toBe('https://github.com/first/app.git')
  await user.clear(input)
  await user.type(input, 'https://github.com/typed/app.git')
  act(() => useAppStore.setState({ repos: [other] }))
  expect(input.value).toBe('https://github.com/typed/app.git')
  // Same destination, new explicit source starts a fresh action rather than inheriting the abandoned draft.
  await renderCard(
    { ...props, repoId: other.id, selectedRepo: other, selectedRepoPath: other.path },
    container
  )
  await user.click(await screen.findByRole('button', { name: /Clone from URL/ }))
  const fresh = screen.getByPlaceholderText('Repository URL')
  if (!(fresh instanceof HTMLInputElement)) {
    throw new Error('Missing fresh URL input')
  }
  expect(fresh.value).toBe('https://github.com/second/app.git')
  await user.type(screen.getByPlaceholderText('/destination/on/host'), '/destination/app')
  await user.click(screen.getByRole('button', { name: 'Clone' }))
  expect(clone).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      url: 'https://github.com/second/app.git',
      hostId: 'runtime:destination',
      destination: '/destination/app'
    })
  )
  await user.keyboard('{Escape}')
  await act(async () => finish({ setup: { id: 'finished-after-dismiss' } }))
  expect(ready).not.toHaveBeenCalled()
  await open()
  const reopened = screen.getByPlaceholderText('Repository URL')
  if (!(reopened instanceof HTMLInputElement)) {
    throw new Error('Missing reopened URL input')
  }
  expect(reopened.value).toBe('https://github.com/second/app.git')
})
