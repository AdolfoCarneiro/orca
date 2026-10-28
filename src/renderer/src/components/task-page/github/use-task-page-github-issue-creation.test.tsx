// @vitest-environment happy-dom
import { act, useRef, useState } from 'react'
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from 'zustand'
import { createUIStore } from '@/store/slices/ui-slice-test-harness'
import { useTaskPageGitHubDetail } from '@/components/task-page/github/use-task-page-github-detail'
import { useTaskPageGitHubIssueCreation } from '@/components/task-page/github/use-task-page-github-issue-creation'
import { useTaskPageWorkspaceActions } from '@/components/task-page/use-task-page-workspace-actions'
import type { TaskPageGitHubListStateModel } from '@/components/task-page/github/use-task-page-github-list-state'
import type { TaskPageWorkspaceActionsModel } from '@/components/task-page/use-task-page-workspace-actions'
import type { TaskPageSearchActionsModel } from '@/components/task-page/use-task-page-search-actions'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { AppState } from '@/store/types'
import type { StoreApi } from 'zustand/vanilla'

const holders = vi.hoisted((): { store: StoreApi<AppState> | null } => ({ store: null }))
const mocks = vi.hoisted(() => ({ createIssue: vi.fn(), workItem: vi.fn(), rpc: vi.fn() }))
vi.mock('@/store/index', async () => {
  const { useStore } = await import('zustand')
  return {
    useAppStore: Object.assign(
      <T,>(selector: (state: AppState) => T) => useStore(holders.store!, selector),
      { getState: () => holders.store!.getState() }
    )
  }
})
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorktree: vi.fn() }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }))
vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }))
vi.mock('@/lib/active-agent-note-send', () => ({
  activeAgentNotesSendFailureMessage: vi.fn(),
  sendNotesToActiveAgentSession: vi.fn()
}))

function item(number: number): GitHubWorkItem {
  return {
    id: `issue:${number}`,
    type: 'issue',
    number,
    title: `Issue ${number}`,
    state: 'open',
    url: `https://github.com/o/r/issues/${number}`,
    labels: [],
    assignees: [],
    updatedAt: '2026-10-28T00:00:00Z',
    author: null,
    repoId: 'repo-1'
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function setup(remote: boolean) {
  const store = createUIStore()
  store.setState({ workItemsCache: {} })
  holders.store = store
  const rendered = renderHook(() => {
    const pageData = useStore(store, (s) => s.taskPageData)
    const [githubMode, setGithubMode] = useState('items')
    const [gitlabDialogItem, setGitlabDialogItem] = useState(null)
    const base = {
      pageData,
      openTaskPage: store.getState().openTaskPage,
      repos: [],
      selectedRepos: [],
      primaryRepo: null,
      githubMode,
      setGithubMode,
      gitlabDialogItem,
      setGitlabDialogItem,
      appliedTaskSearch: '',
      githubPerRepoPageLimit: 36,
      githubResumeContextKey: 'local',
      pages: [],
      currentPage: 0,
      currentPageRef: useRef(0),
      githubListScrollRef: useRef(null),
      githubListScrollTopRef: useRef(0),
      pendingGithubScrollRestoreRef: useRef(null),
      githubListRestoreWriteRef: useRef(null),
      taskListPositionRef: useRef(null)
    }
    // SAFETY: this production hook only reads the fields supplied above.
    const detail = useTaskPageGitHubDetail(base as unknown as TaskPageGitHubListStateModel)
    const actions = { ...detail, openModal: store.getState().openModal }
    // SAFETY: this production hook only reads repos and openModal from the stage model.
    const workspace = useTaskPageWorkspaceActions(actions as unknown as TaskPageSearchActionsModel)
    const [newIssueOpen, setNewIssueOpen] = useState(true)
    const [newIssueTitle, setNewIssueTitle] = useState('Created issue')
    const [newIssueBody, setNewIssueBody] = useState('Body')
    const [newIssueLabels, setNewIssueLabels] = useState<string[]>([])
    const [newIssueAssignees, setNewIssueAssignees] = useState([])
    const [newIssueSubmitting, setNewIssueSubmitting] = useState(false)
    const [taskRefreshNonce, setTaskRefreshNonce] = useState(0)
    const creation = {
      ...workspace,
      newIssueOpen,
      setNewIssueOpen,
      newIssueTitle,
      setNewIssueTitle,
      newIssueBody,
      setNewIssueBody,
      newIssueLabels,
      setNewIssueLabels,
      newIssueAssignees,
      setNewIssueAssignees,
      newIssueSubmitting,
      setNewIssueSubmitting,
      taskRefreshNonce,
      setTaskRefreshNonce,
      setNewIssueDraft: vi.fn(),
      clearNewIssueDraft: vi.fn(),
      newIssueTargetRepo: { id: 'repo-1', path: '/repo', displayName: 'Repo', addedAt: 1 },
      newIssueSourceContext: null,
      newIssueRuntimeTarget: remote ? { kind: 'environment', environmentId: 'builder' } : null
    }
    // SAFETY: this production hook only reads the fields supplied above.
    return useTaskPageGitHubIssueCreation(creation as unknown as TaskPageWorkspaceActionsModel)
  })
  return { ...rendered, store }
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.clearAllMocks()
  mocks.createIssue.mockResolvedValue({ ok: true, number: 1, url: item(1).url })
  mocks.rpc.mockImplementation((_target, method, ...args) =>
    method === 'github.createIssue' ? mocks.createIssue(...args) : mocks.workItem(...args)
  )
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      gh: {
        createIssue: mocks.createIssue,
        workItem: mocks.workItem
      }
    }
  })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  holders.store = null
})

describe.each([
  { route: 'desktop', remote: false },
  { route: 'runtime', remote: true }
])('created issue hydration ownership via $route', ({ remote }) => {
  it('hydrates an immediately returned issue', async () => {
    mocks.workItem.mockResolvedValue({ ...item(1), title: 'Immediate full issue' })
    const { result, store } = setup(remote)
    await act(async () => {
      await result.current.handleCreateNewIssue()
    })
    expect(store.getState().githubTaskDrawerWorkItem?.title).toBe('Immediate full issue')
  })
  it('hydrates the created issue when it remains selected', async () => {
    const pending = deferred<GitHubWorkItem>()
    mocks.workItem.mockReturnValue(pending.promise)
    const { result, store } = setup(remote)
    await act(async () => {
      await result.current.handleCreateNewIssue()
    })
    expect(store.getState().githubTaskDrawerWorkItem?.number).toBe(1)
    await act(async () => {
      pending.resolve({ ...item(1), title: 'Hydrated one' })
      await pending.promise
    })
    expect(store.getState().githubTaskDrawerWorkItem?.title).toBe('Hydrated one')
  })
  it.each([
    { description: 'another issue', next: item(2) },
    {
      description: 'the same issue number in another repository',
      next: { ...item(1), repoId: 'repo-2', url: 'https://github.com/o/other/issues/1' }
    },
    {
      description: 'the same repo id and issue number on another host',
      next: { ...item(1), repoHostId: 'ssh:other' as const }
    }
  ])('preserves a newer selection of $description', async ({ next }) => {
    const pending = deferred<GitHubWorkItem>()
    mocks.workItem.mockReturnValue(pending.promise)
    const { result, store } = setup(remote)
    await act(async () => {
      await result.current.handleCreateNewIssue()
    })
    act(() => {
      result.current.openGitHubDetailPage(next)
    })
    expect(store.getState().githubTaskDrawerWorkItem).toBe(next)
    await act(async () => {
      pending.resolve(item(1))
      await pending.promise
    })
    expect(store.getState().githubTaskDrawerWorkItem).toBe(next)
    expect(store.getState().taskPageData.openGitHubWorkItem).toBe(next)
  })
  it('keeps the drawer closed when the created issue detail arrives after leaving Tasks', async () => {
    const pending = deferred<GitHubWorkItem>()
    mocks.workItem.mockReturnValue(pending.promise)
    const { result, store } = setup(remote)
    await act(async () => {
      await result.current.handleCreateNewIssue()
    })
    act(() => {
      store.getState().closeTaskPage()
    })
    expect(store.getState().githubTaskDrawerWorkItem).toBeNull()
    await act(async () => {
      pending.resolve(item(1))
      await pending.promise
    })
    expect(store.getState().githubTaskDrawerWorkItem).toBeNull()
  })
  it('keeps the list open after navigating back from the created issue', async () => {
    const pending = deferred<GitHubWorkItem>()
    mocks.workItem.mockReturnValue(pending.promise)
    const { result, store } = setup(remote)
    await act(async () => {
      await result.current.handleCreateNewIssue()
    })
    act(() => {
      store.getState().openTaskPage({ taskSource: 'github' })
    })
    expect(store.getState().githubTaskDrawerWorkItem).toBeNull()
    await act(async () => {
      pending.resolve(item(1))
      await pending.promise
    })
    expect(store.getState().githubTaskDrawerWorkItem).toBeNull()
  })
  it('does not hydrate a parked Tasks view after switching to a workspace', async () => {
    const pending = deferred<GitHubWorkItem>()
    mocks.workItem.mockReturnValue(pending.promise)
    const { result, store } = setup(remote)
    await act(async () => {
      await result.current.handleCreateNewIssue()
    })
    const stub = store.getState().githubTaskDrawerWorkItem
    act(() => {
      store.getState().setActiveView('terminal')
    })
    await act(async () => {
      pending.resolve(item(1))
      await pending.promise
    })
    expect(store.getState().githubTaskDrawerWorkItem).toBe(stub)
  })
  it('keeps the drawer closed after using the issue in the workspace composer', async () => {
    const pending = deferred<GitHubWorkItem>()
    mocks.workItem.mockReturnValue(pending.promise)
    const { result, store } = setup(remote)
    await act(async () => {
      await result.current.handleCreateNewIssue()
    })
    const stub = store.getState().githubTaskDrawerWorkItem
    if (!stub) {
      throw new Error('Expected the created issue to be open')
    }
    act(() => {
      result.current.setDialogWorkItem(null)
      result.current.handleUseWorkItem(stub)
    })
    expect(store.getState().activeModal).toBe('new-workspace-composer')
    expect(store.getState().taskPageData.openGitHubWorkItem).toBe(stub)
    expect(store.getState().githubTaskDrawerWorkItem).toBeNull()
    await act(async () => {
      pending.resolve(item(1))
      await pending.promise
    })
    expect(store.getState().activeModal).toBe('new-workspace-composer')
    expect(store.getState().githubTaskDrawerWorkItem).toBeNull()
  })
})
