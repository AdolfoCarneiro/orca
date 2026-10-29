// @vitest-environment happy-dom
import {
  reads,
  task,
  store,
  source,
  deferredIssueSetters,
  useRoutingFixture
} from './task-page-linear-refresh-test-fixtures'
import { reads as issueReadRegistry } from '@/store/slices/linear/linear-issue-read-lifecycle'
import { useTaskCreationDraftRetention } from '../../use-task-creation-draft-retention'
import { writeNewLinearIssueDraft } from '../task-page-draft-storage'
import { useAppStore } from '@/store'
import { toast } from 'sonner'
import { pendingLinearIssueWrites } from '@/store/slices/linear/linear-issue-publication'
import { getLinearSourceScope } from '@/store/slices/linear/linear-slice-scope'
import { writeLinearIssue } from '@/lib/linear-issue-write'
import { defaultScopeSource } from '@/lib/default-creation-host'
import { useLinearIssueWorkspaceDetail } from '../../linear-issue-workspace-detail-state'
import type { LinearIssue } from '../../../../../shared/linear/issue-types'
import { expect, it, vi } from 'vitest'
import { act, renderHook, waitFor, render, screen } from '@testing-library/react'
import { deferred } from '../../../store/slices/linear-slice-test-harness'

import { Suspense, startTransition, useState, useLayoutEffect } from 'react'
import { useLinearIssuePublication } from '@/hooks/useLinearIssuePublication'
import type { useTaskPageDetailRouting } from '../use-task-page-detail-routing'
import { useTaskPageLinearIssueCreation } from './use-task-page-linear-issue-creation'
import { useTaskPageLinearCustomViewEffects } from './use-task-page-linear-custom-view-effects'

it.each([true, false])(
  'publication speculative B (suspend=%s) preserves committed authority',
  async (suspend) => {
    store()
    const A = source('local'),
      B = { ...A, accountLabel: 'B' }
    const blocked = deferred<void>()
    const pending = deferred<{ ok: boolean }>()
    const seen: string[] = [],
      committed: string[] = []
    let navigate!: (value: boolean) => void
    function Consumer({ b }: { b: boolean }) {
      const row = useLinearIssuePublication(task(), b ? B : A).issue!
      seen.push(b ? 'B' : 'A')
      useLayoutEffect(() => {
        committed.push(b ? 'B' : 'A')
      })
      if (b && suspend) {
        throw blocked.promise
      }
      return (
        <output data-testid="publication-scope">
          {b ? 'B' : 'A'}:{row.priority}
        </output>
      )
    }
    function Harness() {
      const [b, setB] = useState(false)
      navigate = setB
      return (
        <Suspense fallback={<span>Blocked</span>}>
          <Consumer b={b} />
        </Suspense>
      )
    }
    const mounted = render(<Harness />)
    await act(async () => {
      startTransition(() => navigate(true))
    })
    expect(seen).toContain('B')
    expect(committed.includes('B')).toBe(!suspend)
    expect(screen.getByTestId('publication-scope').textContent).toBe(suspend ? 'A:0' : 'B:0')
    let saving!: Promise<{ ok: boolean }>
    act(() => {
      saving = writeLinearIssue(task(), { priority: 4 }, A, () => pending.promise)
    })
    if (suspend) {
      await act(async () => {
        navigate(false)
      })
    }
    const visible = screen.getByTestId('publication-scope').textContent
    try {
      expect(visible).toBe(suspend ? 'A:4' : 'B:0')
    } finally {
      mounted.unmount()
      pending.resolve({ ok: false })
      await saving
      expect(pendingLinearIssueWrites.size).toBe(0)
      expect(issueReadRegistry.size).toBe(0)
    }
  }
)

it.each([
  { suspend: true, change: 'source' },
  { suspend: false, change: 'source' },
  { suspend: true, change: 'selection' },
  { suspend: false, change: 'selection' }
])(
  'pending creation speculative B $change (suspend=$suspend) preserves committed selection',
  async ({ suspend, change }) => {
    const s = store()
    s.setState({ recordFeatureInteraction: vi.fn(), jiraIssueCache: {}, jiraSearchCache: {} })
    const A = source('local'),
      B = { ...A, accountLabel: 'B' }
    const creating = deferred<{ ok: boolean; id: string; identifier: string }>()
    const hydration = deferred<LinearIssue | null>()
    const blocked = deferred<void>()
    reads.create.mockReturnValue(creating.promise)
    reads.detail.mockReturnValue(hydration.promise)
    const seen: string[] = [],
      committed: string[] = []
    let navigate!: (value: boolean) => void
    let create!: () => Promise<void>
    let currentForm!: ReturnType<typeof useCreateFixture>
    function Consumer({ b }: { b: boolean }) {
      const context = b && change === 'source' ? B : A
      const model = useCreateFixture(context)
      const isB = change === 'source' ? b : model.selectedLinearIssue?.id === 'selected-B'
      useLayoutEffect(() => {
        create = model.handleCreateNewLinearIssue
        currentForm = model
        committed.push(isB ? 'B' : 'A')
        if (change === 'selection') {
          navigate = () => model.setSelectedLinearIssue({ ...task('Selected B'), id: 'selected-B' })
        }
      })
      seen.push(isB ? 'B' : 'A')
      if (isB && suspend) {
        throw blocked.promise
      }
      return (
        <output data-testid="creation-scope">
          {isB ? 'B' : 'A'}:{model.selectedLinearIssue?.state.name ?? 'none'}:
          {String(model.submitting)}
        </output>
      )
    }
    function Harness() {
      const [b, setB] = useState(false)
      if (change === 'source') {
        navigate = setB
      }
      return (
        <Suspense fallback={<span>Blocked</span>}>
          <Consumer b={b} />
        </Suspense>
      )
    }
    const mounted = render(<Harness />)
    let saving!: Promise<void>
    act(() => {
      saving = create()
    })
    await act(async () => {
      startTransition(() => navigate(true))
    })
    expect(seen).toContain('B')
    expect(committed.includes('B')).toBe(!suspend)
    if (!suspend) {
      act(() => {
        currentForm.setNewLinearIssueTitle('Successor')
        currentForm.setNewLinearIssueBody('Successor body')
      })
    }
    await act(async () => {
      creating.resolve({ ok: true, id: task().id, identifier: task().identifier })
      await saving
    })
    await act(async () => {
      hydration.resolve(task('Created External'))
      await hydration.promise
    })
    if (suspend && change === 'source') {
      await act(async () => {
        navigate(false)
      })
    }
    const visible = screen.getByTestId('creation-scope').textContent
    try {
      if (!suspend) {
        expect(currentForm).toMatchObject({
          title: 'Successor',
          body: 'Successor body',
          open: true
        })
      }
      expect(visible).toBe(
        suspend
          ? 'A:Created External:false'
          : change === 'source'
            ? 'B:none:false'
            : 'B:Selected B:false'
      )
    } finally {
      mounted.unmount()
      expect(pendingLinearIssueWrites.size).toBe(0)
      expect(issueReadRegistry.size).toBe(0)
    }
  }
)

it.each([true, false])(
  'real routing updater discard (suspend=%s) cannot retire a pending field publication',
  async (suspend) => {
    const s = store()
    s.setState({ jiraIssueCache: {}, jiraSearchCache: {} })
    const context = defaultScopeSource(null)
    const pendingPriority = deferred<{ ok: boolean }>(),
      pendingTitle = deferred<{ ok: boolean }>(),
      pendingEarlierTitle = deferred<{ ok: boolean }>()
    const hydrated = deferred<LinearIssue | null>(),
      blocked = deferred<void>()
    reads.detail.mockReturnValue(hydrated.promise)
    let route!: ReturnType<typeof useTaskPageDetailRouting>
    let pulse!: () => void
    const renders: string[] = [],
      commits: string[] = []
    let block = true
    function Consumer() {
      const [tick, setTick] = useState(0)
      const current = useRoutingFixture(null)
      useLayoutEffect(() => {
        route = current
        pulse = () => setTick((n) => n + 1)
        commits.push(
          `${current.selectedLinearIssue?.state.name}:${current.selectedLinearIssue?.priority}`
        )
      })
      renders.push(
        `${current.selectedLinearIssue?.state.name}:${current.selectedLinearIssue?.priority}`
      )
      if (suspend && block && current.selectedLinearIssue?.state.name === 'Hydrated') {
        throw blocked.promise
      }
      return (
        <output data-testid="hydration-scope">
          {current.selectedLinearIssue?.title}:{current.selectedLinearIssue?.priority}:{tick}
        </output>
      )
    }
    const mounted = render(
      <Suspense fallback={<span>Blocked</span>}>
        <Consumer />
      </Suspense>
    )
    act(() => route.setSelectedLinearIssue(task()))
    let lease!: ReturnType<ReturnType<typeof s.getState>['fetchLinearIssue']> extends {
      acquire: () => infer L
    }
      ? L
      : never
    let prioritySaving!: Promise<{ ok: boolean }>,
      titleSaving!: Promise<{ ok: boolean }>,
      earlierTitleSaving!: Promise<{ ok: boolean }>
    await act(async () => {
      startTransition(() => {
        earlierTitleSaving = writeLinearIssue(
          task(),
          { title: 'Earlier title' },
          context,
          () => pendingEarlierTitle.promise
        )
        prioritySaving = writeLinearIssue(
          task(),
          { priority: 4 },
          context,
          () => pendingPriority.promise
        )
        lease = s
          .getState()
          .fetchLinearIssue(task().id, 'w', { force: true, seed: task() })
          .acquire()
      })
      hydrated.resolve(task('Hydrated'))
      await hydrated.promise
      await Promise.resolve()
      await Promise.resolve()
      const view = lease.currentView()
      expect(view.data?.state.name).toBe('Hydrated')
      expect(view.data?.priority).toBe(4)
      startTransition(() =>
        route.setSelectedLinearIssue(view.data, {
          expectedSelection: route.linearSelectionRequest,
          isCurrent: () => lease.commit(view, false, () => true)
        })
      )
    })
    expect(renders).toContain('Hydrated:4')
    expect(commits.includes('Hydrated:4')).toBe(!suspend)
    // A real later field write retires the delivered read but must not erase pending priority.
    act(() => {
      titleSaving = writeLinearIssue(
        task(),
        { title: 'Current title' },
        context,
        () => pendingTitle.promise
      )
      pulse()
    })
    block = false
    await act(async () => {
      pulse()
    })
    const visible = screen.getByTestId('hydration-scope').textContent
    const { projectLinearIssue } = await import('@/store/slices/linear/linear-issue-publication')
    expect(projectLinearIssue(getLinearSourceScope(context), task()).priority).toBe(4)
    try {
      expect(visible).toContain('Current title:4:')
    } finally {
      mounted.unmount()
      lease.release()
      pendingTitle.resolve({ ok: false })
      pendingPriority.resolve({ ok: false })
      pendingEarlierTitle.resolve({ ok: false })
      await Promise.all([prioritySaving, titleSaving, earlierTitleSaving])
      expect(pendingLinearIssueWrites.size).toBe(0)
      expect(issueReadRegistry.size).toBe(0)
    }
  }
)

it('committed hydration survives actual skipped-lane replay, force loading and terminal failure', async () => {
  const s = store()
  const first = deferred<LinearIssue | null>(),
    h = deferred<LinearIssue | null>()
  let rejectReplacement!: (error: Error) => void
  const replacement = new Promise<LinearIssue | null>((_resolve, reject) => {
    rejectReplacement = reject
  })
  reads.detail
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(h.promise)
    .mockReturnValueOnce(replacement)
  const pending = deferred<{ ok: boolean }>(),
    blocked = deferred<void>()
  let hold = true
  let enroll!: () => void
  let saving!: Promise<{ ok: boolean }>
  const committed: string[] = [],
    rendered: string[] = []
  function Detail() {
    const [low, setLow] = useState(false)
    const detail = useLinearIssueWorkspaceDetail({
      issue: task(),
      providerSettings: defaultScopeSource(null),
      requestKey: 'H'
    })
    const value = `${detail.displayed.priority}:${detail.editState.priority}:${detail.issueLoading}:${low}`
    rendered.push(value)
    useLayoutEffect(() => {
      committed.push(value)
      enroll = () => setLow(true)
    })
    if (low && hold) {
      throw blocked.promise
    }
    return <output data-testid="replay">{value}</output>
  }
  const mounted = render(
    <Suspense fallback={<span>Blocked</span>}>
      <Detail />
    </Suspense>
  )
  await act(async () => {
    startTransition(() => {
      enroll()
      saving = writeLinearIssue(
        task(),
        { priority: 4 },
        defaultScopeSource(null),
        () => pending.promise
      )
    })
  })
  expect(rendered.some((value) => value.startsWith('4:4:') && value.endsWith(':true'))).toBe(true)
  expect(committed.some((value) => value.startsWith('4:4:'))).toBe(false)
  await act(async () => {
    pending.resolve({ ok: false })
    await saving
  })
  expect(pendingLinearIssueWrites.size).toBe(0)
  expect(reads.detail).toHaveBeenCalledTimes(2)
  await act(async () => {
    h.resolve({ ...task('H'), priority: 2 })
    await h.promise
  })
  expect(screen.getByTestId('replay').textContent).toBe('2:2:false:false')
  act(() => {
    s.getState().fetchLinearIssue(task().id, 'w', { force: true })
  })
  expect(reads.detail).toHaveBeenCalledTimes(3)
  expect(screen.getByTestId('replay').textContent).toBe('2:2:true:false')
  hold = false
  await act(async () => {
    blocked.resolve()
    await blocked.promise
  })
  expect(screen.getByTestId('replay').textContent).toBe('2:2:true:true')
  await act(async () => {
    rejectReplacement(new Error('offline'))
    await replacement.catch(() => {})
  })
  expect(screen.getByTestId('replay').textContent).toBe('2:2:false:true')
  expect(reads.detail).toHaveBeenCalledTimes(3)
  reads.detail.mockResolvedValueOnce({ ...task('G'), priority: 3 })
  await act(async () => {
    s.getState().fetchLinearIssue(task().id, 'w', { force: true })
  })
  expect(screen.getByTestId('replay').textContent).toBe('3:3:false:true')
  mounted.unmount()
  first.resolve(task('retired'))
  await first.promise
  expect(pendingLinearIssueWrites.size).toBe(0)
  expect(issueReadRegistry.size).toBe(0)
  act(() => s.getState().patchLinearIssue(task().id, { priority: 4 }))
  expect(reads.detail).toHaveBeenCalledTimes(4)
})

it('acknowledges only captured field t, leaving newer u delivered before layout acknowledgement', async () => {
  const s = store(),
    context = defaultScopeSource(null)
  const t = deferred<{ ok: boolean }>(),
    u = deferred<{ ok: boolean }>()
  let savingT!: Promise<{ ok: boolean }>, savingU!: Promise<{ ok: boolean }>
  let current!: ReturnType<typeof useLinearIssuePublication>
  let publishU = false
  function Consumer() {
    useLayoutEffect(() => {
      if (publishU && publication.issue?.state.name === 'H') {
        publishU = false
        deferredIssueSetters.enabled = true
        savingU = writeLinearIssue(task(), { priority: 2 }, context, () => u.promise)
        deferredIssueSetters.enabled = false
      }
    })
    const publication = useLinearIssuePublication(task(), context)
    useLayoutEffect(() => {
      current = publication
    })
    return <output data-testid="ack">{publication.issue?.priority}</output>
  }
  const mounted = render(<Consumer />)
  act(() => {
    savingT = writeLinearIssue(task(), { priority: 4 }, context, () => t.promise)
  })
  reads.detail.mockResolvedValue({ ...task('H'), priority: 1 })
  const lease = s.getState().fetchLinearIssue(task().id, 'w', { force: true }).acquire()
  const view = await lease.waitForCurrentTerminal()
  publishU = true
  act(() => current.read(lease, view))
  expect(screen.getByTestId('ack').textContent).toBe('4')
  const delayedU = deferredIssueSetters.updates.splice(0)
  expect(delayedU.length).toBeGreaterThan(0)
  act(() => delayedU.forEach((deliver) => deliver()))
  expect(screen.getByTestId('ack').textContent).toBe('2')
  mounted.unmount()
  lease.release()
  u.resolve({ ok: false })
  t.resolve({ ok: false })
  await Promise.all([savingT, savingU])
  expect(pendingLinearIssueWrites.size).toBe(0)
  expect(issueReadRegistry.size).toBe(0)
})

it('committed field t reconstructs while newer u is in a genuinely suspended lane', async () => {
  store()
  const t = deferred<{ ok: boolean }>(),
    u = deferred<{ ok: boolean }>(),
    blocked = deferred<void>()
  let savingT!: Promise<{ ok: boolean }>, savingU!: Promise<{ ok: boolean }>
  let enqueue!: () => void, pulse!: () => void
  let hold = true
  const commits: string[] = []
  function Consumer() {
    const [low, setLow] = useState(false),
      [tick, setTick] = useState(0)
    const publication = useLinearIssuePublication(task(), defaultScopeSource(null))
    const value = `${publication.issue?.priority}:${low}:${tick}`
    useLayoutEffect(() => {
      enqueue = () => setLow(true)
      pulse = () => setTick((n) => n + 1)
      commits.push(value)
    })
    if (low && hold) {
      throw blocked.promise
    }
    return <output data-testid="field-replay">{value}</output>
  }
  const mounted = render(
    <Suspense fallback={<span>Blocked</span>}>
      <Consumer />
    </Suspense>
  )
  act(() => {
    savingT = writeLinearIssue(task(), { priority: 4 }, defaultScopeSource(null), () => t.promise)
  })
  expect(screen.getByTestId('field-replay').textContent).toBe('4:false:0')
  await act(async () => {
    startTransition(() => {
      enqueue()
      savingU = writeLinearIssue(task(), { priority: 2 }, defaultScopeSource(null), () => u.promise)
    })
  })
  expect(commits.some((value) => value.startsWith('2:'))).toBe(false)
  act(() => pulse())
  expect(screen.getByTestId('field-replay').textContent).toBe('4:false:1')
  hold = false
  await act(async () => {
    blocked.resolve()
    await blocked.promise
  })
  expect(screen.getByTestId('field-replay').textContent).toBe('2:true:1')
  mounted.unmount()
  t.resolve({ ok: false })
  u.resolve({ ok: false })
  await Promise.all([savingT, savingU])
  expect(pendingLinearIssueWrites.size).toBe(0)
  expect(issueReadRegistry.size).toBe(0)
})

function useCreateFixture(
  context: ReturnType<typeof source>,
  initial: LinearIssue | null = null,
  initialTitle = 'Created'
) {
  const draft = useAppStore.getState().newLinearIssueDraft
  const noop = vi.fn(),
    [title, setTitle] = useState(draft?.title ?? initialTitle),
    [body, setBody] = useState(draft?.body ?? (initialTitle ? 'Body' : '')),
    [open, setOpen] = useState(true),
    [submitting, setSubmitting] = useState(false)
  const route = useRoutingFixture(context, initial)
  const discard = useTaskCreationDraftRetention({
    open,
    draft: { title, body },
    writeDraft: writeNewLinearIssueDraft
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture supplies the real consumer's exercised fields and actions; unrelated full-page/provider services are intentionally absent.
  const creation = useTaskPageLinearIssueCreation({
    ...route,
    settings: null,
    providerRuntimeContextKey: 'runtime',
    providerRuntimeContextKeyRef: { current: 'runtime' },
    linearTaskSourceContext: context,
    setLinearRefreshNonce: noop,
    selectedLinearProject: null,
    setNewLinearIssueOpen: setOpen,
    newLinearIssueTitle: title,
    setNewLinearIssueTitle: setTitle,
    newLinearIssueBody: body,
    setNewLinearIssueBody: setBody,
    newLinearIssueSubmitting: submitting,
    setNewLinearIssueSubmitting: setSubmitting,
    newLinearIssueStateId: null,
    setNewLinearIssueStateId: noop,
    newLinearIssueAssigneeId: null,
    setNewLinearIssueAssigneeId: noop,
    newLinearIssuePriority: 0,
    setNewLinearIssuePriority: noop,
    newLinearIssueProjectId: null,
    setNewLinearIssueProjectId: noop,
    newLinearIssueLabelIds: [],
    setNewLinearIssueLabelIds: noop,
    discardNewLinearIssueDraft: discard,
    newLinearIssueTargetTeam: { id: 'team-1', workspaceId: 'w' }
  } as never)
  return { ...creation, submitting, title, body, open }
}

it.each([
  { unmount: false, ok: true },
  { unmount: true, ok: true },
  { unmount: true, ok: false }
])(
  'create held over unmount=$unmount ok=$ok completes the session draft without orphan demand',
  async ({ unmount, ok }) => {
    const s = store(),
      context = source('local')
    s.setState({ recordFeatureInteraction: vi.fn(), jiraIssueCache: {}, jiraSearchCache: {} })
    const creating = deferred<{ ok: boolean; id: string; identifier: string }>()
    reads.create.mockReturnValue(creating.promise)
    reads.detail.mockResolvedValue({ ...task('Created'), id: 'N' })
    const success = vi.spyOn(toast, 'success')
    const hook = renderHook(() => useCreateFixture(context))
    let saving!: Promise<void>
    act(() => {
      saving = hook.result.current.handleCreateNewLinearIssue()
    })
    if (unmount) {
      hook.unmount()
      expect(s.getState().newLinearIssueDraft).toEqual({ title: 'Created', body: 'Body' })
    }
    await act(async () => {
      creating.resolve({ ok, id: 'N', identifier: 'ENG-2' })
      await saving
    })
    expect(reads.create).toHaveBeenCalledTimes(1)
    expect(success).toHaveBeenCalledTimes(ok ? 1 : 0)
    expect(s.getState().newLinearIssueDraft).toEqual(ok ? null : { title: 'Created', body: 'Body' })
    expect(reads.detail).toHaveBeenCalledTimes(unmount ? 0 : 1)
    if (!unmount) {
      await waitFor(() => expect(hook.result.current.selectedLinearIssue?.id).toBe('N'))
      expect(hook.result.current).toMatchObject({
        submitting: false,
        open: false,
        title: '',
        body: ''
      })
      hook.unmount()
    }
    expect(pendingLinearIssueWrites.size).toBe(0)
    expect(issueReadRegistry.size).toBe(0)
    const reopened = renderHook(() => useCreateFixture(context, null, ''))
    expect(reopened.result.current.title).toBe(ok ? '' : 'Created')
    expect(reopened.result.current.body).toBe(ok ? '' : 'Body')
    reopened.unmount()
    act(() => s.getState().patchLinearIssue('N', { priority: 4 }, { sourceContext: context }))
    expect(reads.detail).toHaveBeenCalledTimes(unmount ? 0 : 1)
  }
)

it('create selects N before pending A settles, without waiting for N follow-up hydration', async () => {
  const s = store(),
    context = source('local')
  s.setState({ recordFeatureInteraction: vi.fn(), jiraIssueCache: {}, jiraSearchCache: {} })
  const pending = deferred<{ ok: boolean }>(),
    held = deferred<LinearIssue | null>()
  const created = {
    ...task('Created N'),
    id: 'N',
    identifier: 'ENG-2',
    title: 'Created title',
    priority: 2
  }
  reads.create.mockResolvedValue({ ok: true, id: 'N', identifier: 'ENG-2' })
  reads.detail.mockImplementation((_context, id) =>
    id === 'N' && reads.detail.mock.calls.filter((call) => call[1] === 'N').length === 1
      ? Promise.resolve(created)
      : held.promise
  )
  const hook = renderHook(() => {
    const creation = useCreateFixture(context, task())
    const detail = useLinearIssueWorkspaceDetail({
      issue: creation.selectedLinearIssue ?? task(),
      providerSettings: context,
      requestKey: creation.selectedLinearIssue?.id ?? 'A'
    })
    return { ...creation, detail }
  })
  let saving!: Promise<{ ok: boolean }>
  act(() => {
    saving = writeLinearIssue(task(), { priority: 4 }, context, () => pending.promise)
  })
  await act(async () => {
    await hook.result.current.handleCreateNewLinearIssue()
  })
  await waitFor(() => expect(hook.result.current.selectedLinearIssue?.id).toBe('N'))
  expect(hook.result.current.detail.displayed).toMatchObject({
    id: 'N',
    title: 'Created title',
    priority: 2,
    workspaceId: 'w'
  })
  await act(async () => {
    pending.resolve({ ok: false })
    await saving
  })
  expect(hook.result.current.detail.displayed).toMatchObject({
    id: 'N',
    title: 'Created title',
    priority: 2,
    workspaceId: 'w'
  })
  expect(hook.result.current.detail.editState.priority).toBe(2)
  expect(hook.result.current.detail.issueLoading).toBe(true)
  hook.unmount()
  held.resolve(null)
  await held.promise
  expect(pendingLinearIssueWrites.size).toBe(0)
  expect(issueReadRegistry.size).toBe(0)
})

it('an empty-list selection clear preserves a pending create and its successful selection', async () => {
  const s = store(),
    context = source('local')
  s.setState({ recordFeatureInteraction: vi.fn(), jiraIssueCache: {}, jiraSearchCache: {} })
  const creating = deferred<{ ok: boolean; id: string; identifier: string }>()
  reads.create.mockReturnValue(creating.promise)
  reads.detail.mockResolvedValue({ ...task('Created'), id: 'N' })
  const hook = renderHook(() => {
    const model = useCreateFixture(context)
    const [emptyRows, setEmptyRows] = useState<LinearIssue[]>([])
    const [connected, setConnected] = useState(true)
    const noop = vi.fn()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only existing selection effect inputs execute; catalog effects are disabled/inert.
    useTaskPageLinearCustomViewEffects({
      ...model,
      taskResumeApplied: true,
      taskSource: 'linear',
      linearMode: 'issues',
      linearConnected: connected,
      selectedLinearCustomView: null,
      linearCustomViewIssueResult: { read: noop, setLoading: noop },
      setLinearCustomViewIssuesResult: noop,
      setLinearCustomViewProjectsResult: noop,
      filteredLinearIssues: emptyRows
    } as never)
    return { ...model, deliver: () => setEmptyRows([]), setConnected }
  })
  let saving!: Promise<void>
  try {
    act(() => {
      saving = hook.result.current.handleCreateNewLinearIssue()
    })
    expect(hook.result.current.submitting).toBe(true)
    const request = hook.result.current.linearSelectionRequest
    act(() => hook.result.current.deliver())
    expect(hook.result.current.linearSelectionRequest).toBe(request)
    act(() => hook.result.current.setConnected(false))
    expect(hook.result.current.linearSelectionRequest).toBe(request)
    expect(hook.result.current.submitting).toBe(true)
    act(() => hook.result.current.setConnected(true))
    expect(reads.create).toHaveBeenCalledTimes(1)
    await act(async () => {
      creating.resolve({ ok: true, id: 'N', identifier: 'ENG-2' })
      await saving
    })
    await waitFor(() => expect(hook.result.current.selectedLinearIssue?.id).toBe('N'))
    expect(hook.result.current.submitting).toBe(false)
    expect(reads.detail).toHaveBeenCalledTimes(1)
    act(() => hook.result.current.deliver())
    expect(hook.result.current.selectedLinearIssue?.id).toBe('N')
    act(() => hook.result.current.setSelectedLinearIssue(task()))
    expect(hook.result.current.selectedLinearIssue).toBeNull()
    act(() => hook.result.current.setSelectedLinearIssue(task(), { allowOutsideList: true }))
    expect(hook.result.current.selectedLinearIssue?.id).toBe(task().id)
    act(() => hook.result.current.setConnected(false))
    expect(hook.result.current.selectedLinearIssue).toBeNull()
  } finally {
    hook.unmount()
    creating.resolve({ ok: true, id: 'N', identifier: 'ENG-2' })
    await saving
    expect(pendingLinearIssueWrites.size).toBe(0)
    expect(issueReadRegistry.size).toBe(0)
    act(() => s.getState().patchLinearIssue('N', { priority: 4 }, { sourceContext: context }))
    expect(reads.detail).toHaveBeenCalledTimes(1)
  }
})
