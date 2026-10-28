import {
  repo,
  source,
  key,
  projectKey,
  seed,
  oldDetails,
  table
} from './github-task-refresh-data.test-fixture'
// @vitest-environment happy-dom
import type * as I18nModule from '@/i18n/i18n'

import React, { act, useState, useLayoutEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createStore, useStore, type StoreApi } from 'zustand'
import { afterEach, beforeEach, expect, vi } from 'vitest'
import type { AppState } from '@/store/types'

import type { GitHubWorkItem } from '../../../shared/github/work-item-types'
import type { GitHubProjectTable, GitHubProjectRow } from '../../../shared/github/project-types'
import { createGitHubSlice } from '@/store/slices/github'
import { TaskPageContent } from '@/components/task-page/Content'
import type { TaskPageComposerActionsModel } from '@/components/task-page/use-task-page-composer-actions'
import { TooltipProvider } from '@/components/ui/tooltip'

import { parseTaskQuery } from '../../../shared/task-query'
import { patchTaskPageGitHubWorkItemPages } from '@/components/task-page/github/task-page-github-work-item-mutation-pages'
import {
  resetTaskPageGitHubMutationRegistryForTests,
  setTaskPageGitHubMutationQueryKey
} from '@/components/task-page/github/task-page-github-work-item-mutation-registry'
import { taskPageGitHubResumeCache } from '@/components/task-page/github/task-page-github-resume-cache'

import { workItemDetailsCache } from '@/components/github-item-dialog/load-item-details/work-item-details-cache'

import { clearRuntimeCompatibilityCacheForTests } from '@/runtime/runtime-rpc-client'

import { useTaskPageGitHubWorkItemMutation } from '@/hooks/useTaskPageGitHubWorkItemMutation'

import {
  createRuntimeStatusSlice,
  clearRuntimeEnvironmentConnectionGenerationsForTests
} from '@/store/slices/runtime-status'

let store: StoreApi<AppState>
vi.mock('@/store', () => ({
  useAppStore: Object.assign((select: (s: AppState) => unknown) => useStore(store, select), {
    getState: () => store.getState(),
    setState: (...args: Parameters<StoreApi<AppState>['setState']>) => store.setState(...args),
    subscribe: (listener: (s: AppState, previous: AppState) => void) => store.subscribe(listener)
  })
}))
vi.mock('@/components/PullRequestPage', () => ({ default: () => null }))
vi.mock('@/components/github-project/ProjectViewWrapper', () => ({ default: () => null }))
vi.mock('@/components/github-project/useProjectViewTable', () => ({
  useProjectViewTable: () => {
    const table = useStore(store, (s) => s.projectViewCache[projectKey]?.data)
    return {
      table,
      visibleTable: table,
      currentCacheKey: projectKey,
      activeProject: table?.project,
      views: [],
      sourceTarget: { kind: 'local' },
      loading: false
    }
  }
}))
vi.mock('@/lib/repo-slug-index', () => ({
  useRepoSlugIndex: () => ({
    ready: true,
    lookupSlug: () => [repo],
    lookupSlugMatches: () => ({ origin: [repo], upstream: [] })
  })
}))
vi.mock('@/components/github-project/ProjectViewToolbar', () => ({
  ProjectViewToolbar: () => null
}))
vi.mock('@/components/github-project/ProjectViewStates', () => ({
  ProjectViewTabStrip: () => null
}))
vi.mock('@/components/github-project/ProjectViewList', () => ({
  default: (p: { table: GitHubProjectTable; onOpenDialog: (r: GitHubProjectRow) => void }) => (
    <button onClick={() => p.onOpenDialog(p.table.rows[0])}>Open Project task</button>
  )
}))
vi.mock('@/components/github-project/ProjectBoard', () => ({ default: () => null }))
vi.mock('@/components/github-project/ProjectRoadmap', () => ({ default: () => null }))
vi.mock('@/components/github-project/ProjectItemSlugDialog', () => ({ default: () => null }))
vi.mock('@/components/github-project/ProjectMissingRepoDialog', () => ({
  ProjectMissingRepoDialog: () => null
}))
vi.mock('@/components/task-page/github/List', () => ({ TaskPageGitHubList: () => null }))
vi.mock('@/components/task-page/gitlab/TodoList', () => ({ TaskPageGitLabTodoList: () => null }))
vi.mock('@/components/task-page/gitlab/ItemList', () => ({ TaskPageGitLabItemList: () => null }))
vi.mock('@/components/task-page/jira/Content', () => ({ TaskPageJiraContent: () => null }))
vi.mock('@/components/github-item-dialog/open-dialog/github-item-dialog-pr-tabs', () => ({
  GitHubItemDialogPRTabs: () => null
}))
vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorktree: vi.fn() }))
vi.mock('@/store/selectors', () => ({ useAllWorktrees: () => [] }))
vi.mock('@/i18n/i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof I18nModule>()),
  translate: (_: string, fallback: string) => fallback
}))
vi.mock('@/hooks/useIssueMetadata', async () => ({
  ...(await import('@/hooks/useImmediateMutation')),
  useRepoLabels: () => ({ data: [] }),
  useRepoAssignees: () => ({ data: [] })
}))
vi.mock('@/hooks/useGitHubSlugMetadata', () => ({
  useRepoLabelsBySlug: () => ({ data: [] }),
  useRepoAssigneesBySlug: () => ({ data: [] })
}))
vi.mock('@/components/github/github-duplicate-issue-candidates', () => ({
  useGitHubDuplicateIssueCandidates: () => []
}))
vi.mock('@/components/github-item-dialog/edit-item-fields/gh-edit-section-top-columns', () => ({
  GHEditSectionTopColumns: (p: {
    localAssignees: string[]
    onAssigneeToggle: (login: string) => void
  }) => (
    <>
      <output data-assignees data-render={++fieldsRenders}>
        {p.localAssignees.join(',')}
      </output>
      <button onClick={() => p.onAssigneeToggle('bob')}>Add Bob</button>
    </>
  )
}))
vi.mock('@/components/github-item-dialog/discuss-item/conversation-tab-description', () => ({
  ConversationTabDescription: (p: {
    body: string
    resolvedBodyDraft: string
    setBodyDraft: (v: string) => void
    setBodyEditing: (v: boolean) => void
    onSaveBody: () => void
  }) => (
    <>
      <output data-body>{p.body}</output>
      <input
        aria-label="Body draft"
        value={p.resolvedBodyDraft}
        onChange={(e) => {
          p.setBodyEditing(true)
          p.setBodyDraft(e.target.value)
        }}
      />
      <button onClick={p.onSaveBody}>Save body</button>
    </>
  )
}))
vi.mock('@/components/github-item-dialog/discuss-item/conversation-tab-activity', () => ({
  ConversationTabActivity: (p: { comments: { body: string }[] }) => (
    <output data-comments>{p.comments.map((c) => c.body).join(',')}</output>
  )
}))
vi.mock('@/components/github/GitHubMarkdownComposer', () => ({
  GitHubMarkdownComposer: (p: { value: string; onChange: (value: string) => void }) => (
    <input
      aria-label="Comment draft"
      value={p.value}
      onChange={(e) => p.onChange(e.target.value)}
    />
  )
}))

let harnessSetPages: React.Dispatch<React.SetStateAction<(GitHubWorkItem[] | null)[]>>
let taskMutation: ReturnType<typeof useTaskPageGitHubWorkItemMutation>
let fieldsRenders = 0
let openedItem = seed,
  openedSource = source
let root: Root,
  container: HTMLDivElement,
  pages: (GitHubWorkItem[] | null)[],
  useItem = vi.fn()
const direct = vi.fn(),
  update = vi.fn(),
  list = vi.fn(),
  issueType = vi.fn(),
  projectRead = vi.fn(),
  postComment = vi.fn()
function fixture(n = 1) {
  const others = Array.from({ length: n - 1 }, (_, i) => ({
    ...seed,
    id: `issue:${i + 10}`,
    number: i + 10,
    url: `https://github.com/o/r/issues/${i + 10}`
  }))
  const twin = {
    ...seed,
    id: 'issue:5',
    url: 'https://github.com/upstream/r/issues/5',
    title: 'Twin'
  }
  store = createStore<AppState>()(
    (...args) =>
      ({
        ...createGitHubSlice(...args),
        ...createRuntimeStatusSlice(...args),
        repos: [repo],
        settings: null,
        runtimeStatusByEnvironmentId: new Map(),
        taskPageData: { openGitHubWorkItem: seed, openGitHubSourceContext: source },
        githubTaskDrawerWorkItem: seed,
        recordFeatureInteraction: vi.fn(),
        recordFeatureInteractionOnce: vi.fn(),
        workItemsCache: {
          [key]: { data: [{ ...seed, id: 'issue:5' }, twin, ...others], fetchedAt: 10 }
        },
        projectViewCache: {
          [projectKey]: { data: table, fetchedAt: 20 },
          [projectKey.replace('view', 'view2')]: { data: table, fetchedAt: 30 }
        }
      }) as AppState
  ) // SAFETY: only selected Task/Project fields and real GitHub slice actions are exercised.
  pages = [null, null, [{ ...seed, id: 'issue:5' }, twin, ...others]]
  return { others, twin }
}
function Harness() {
  const mutation = useTaskPageGitHubWorkItemMutation({
    queryKey: 'q',
    query: parseTaskQuery('is:open'),
    viewerLogin: 'alice',
    patchWorkItem: store.getState().patchWorkItem
  })
  const [localPages, setPages] = useState(pages)
  useLayoutEffect(() => {
    taskMutation = mutation
    pages = localPages
    harnessSetPages = setPages
  }, [mutation, localPages])
  const model = {
    taskSource: 'github',
    dialogWorkItem: openedItem,
    dialogRepoPath: repo.path,
    dialogSourceContext: openedSource,
    dialogInitialTab: undefined,
    selectedRepos: store.getState().repos,
    appliedTaskQuery: parseTaskQuery('is:open'),
    githubWorkItemMutationQueryKey: 'q',
    githubViewerLogin: 'alice',
    setDialogWorkItem: vi.fn(),
    handleUseWorkItem: useItem,
    closeTaskDetailPage: vi.fn(),
    patchTaskPageWorkItemRows: (
      item: GitHubWorkItem,
      patch: Partial<GitHubWorkItem>,
      matches: (row: GitHubWorkItem) => boolean
    ) => setPages((current) => patchTaskPageGitHubWorkItemPages(current, item, patch, matches))
  }
  return (
    <TooltipProvider>
      <TaskPageContent model={model as TaskPageComposerActionsModel} />
    </TooltipProvider>
  ) // SAFETY: this fixture deliberately renders only the issue branch with its production accepted callback.
}
async function mount() {
  await act(async () => {
    root.render(<Harness />)
  })
}
async function click(label = 'Refresh task') {
  const button = Array.from(container.querySelectorAll('button')).find(
    (b) => b.getAttribute('aria-label') === label || b.textContent === label
  )
  expect(button, label).toBeTruthy()
  await act(async () => {
    button!.click()
  })
}
async function draft(label: string, value: string) {
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
beforeEach(() => {
  openedItem = seed
  openedSource = source
  clearRuntimeCompatibilityCacheForTests()
  clearRuntimeEnvironmentConnectionGenerationsForTests()
  vi.clearAllMocks()
  workItemDetailsCache.clear()
  resetTaskPageGitHubMutationRegistryForTests()
  setTaskPageGitHubMutationQueryKey('q')
  fixture()
  Object.assign(window, {
    api: {
      gh: {
        workItemDetails: direct,
        updateIssue: update,
        updateIssueBySlug: update,
        addIssueComment: postComment,
        listWorkItems: list,
        countWorkItems: vi.fn().mockResolvedValue(0),
        getProjectViewTable: projectRead,
        updateIssueTypeBySlug: issueType
      },
      shell: { openUrl: vi.fn() }
    }
  })
  direct.mockResolvedValue(oldDetails)
  update.mockResolvedValue({ ok: true })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  taskPageGitHubResumeCache.clear()
  workItemDetailsCache.clear()
})

export {
  useItem,
  store,
  fieldsRenders,
  container,
  taskMutation,
  harnessSetPages,
  direct,
  update,
  list,
  issueType,
  projectRead,
  postComment,
  fixture,
  mount,
  click,
  draft
}
export const context = {
  get pages() {
    return pages
  },
  set pages(value: typeof pages) {
    pages = value
  },
  get root() {
    return root
  },
  set root(value: typeof root) {
    root = value
  },
  get openedItem() {
    return openedItem
  },
  set openedItem(value: typeof openedItem) {
    openedItem = value
  },
  get openedSource() {
    return openedSource
  },
  set openedSource(value: typeof openedSource) {
    openedSource = value
  }
}
