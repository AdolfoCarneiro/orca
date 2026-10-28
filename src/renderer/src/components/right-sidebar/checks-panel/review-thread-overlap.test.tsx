// @vitest-environment happy-dom

import { useRef, useState } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { PRComment } from '../../../../../shared/github/comment-types'
import { mockApi, makePR, resetRemoteRuntimeMocks } from '@/store/slices/github-slice-test-harness'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { TooltipProvider } from '@/components/ui/tooltip'
import { PRCommentsList } from '@/components/right-sidebar/checks-panel/comments-list'
import { useChecksPanelCommentResolution } from '@/components/right-sidebar/checks-panel/use-checks-panel-comment-resolution'
import { gitHubPRToChecksPanelReview } from '@/components/right-sidebar/checks-panel-review'

vi.mock('@/components/tab-bar/use-new-tab-agent-menu-rows', () => ({
  useAgentMenuObservation: () => ({ preferencesPending: true })
}))
vi.mock('@/hooks/useAgentDetectionTarget', () => ({
  useAgentDetectionTargetForWorktree: () => null
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

const browserWindow = document.defaultView
if (!browserWindow) {
  throw new Error('Missing happy-dom window')
}
Object.assign(browserWindow, { api: mockApi })
Object.defineProperty(globalThis, 'window', { value: browserWindow, configurable: true })
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const repo = {
  id: 'overlap-repo',
  path: '/repo',
  displayName: 'Repo',
  badgeColor: '#000',
  addedAt: 0
}
const threadId = 'thread-10'
const pr = makePR({ prRepo: { owner: 'Acme', repo: 'Widgets' } })
const cacheKey = `${repo.id}::pr-comments::acme/widgets::12`
const original: PRComment = {
  id: 10,
  author: 'reviewer',
  authorAvatarUrl: '',
  body: 'Original',
  threadId,
  isResolved: true,
  createdAt: '2026-10-28T00:00:00Z',
  url: '',
  path: 'src/a.ts',
  line: 1
}

function Panel({ prValue = pr }: { prValue?: typeof pr }) {
  const [comments, setComments] = useState([original])
  const model: Parameters<typeof useChecksPanelCommentResolution>[0] = {
    activeWorktree: null,
    activeWorktreeId: null,
    claimedCommentResolutionRef: useRef(null),
    commentResolutionAckBusy: false,
    commentsLoading: false,
    detectedAgentIds: null,
    pendingCommentResolutionRef: useRef(null),
    repo,
    resolveReviewThread: useAppStore.getState().resolveReviewThread,
    setAgentComposerState: () => {},
    setComments,
    settings: useAppStore.getState().settings,
    commentResolutionLaunchAcceptedRef: useRef(false),
    activeGitLabReview: null,
    activeReview: gitHubPRToChecksPanelReview(prValue),
    pr: prValue,
    prNumber: prValue.number,
    sourceControlAiActionsVisible: false
  }
  const { handleResolve, getThreadResolutionKey } = useChecksPanelCommentResolution(model)
  return (
    <TooltipProvider>
      <output data-testid="panel-resolution">{String(comments[0]?.isResolved)}</output>
      <PRCommentsList
        comments={comments}
        commentsLoading={false}
        selectionContextKey="overlap-review"
        onResolve={handleResolve}
        getThreadResolutionKey={getThreadResolutionKey}
      />
    </TooltipProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockApi.gh.resolveReviewThread.mockReset()
  resetRemoteRuntimeMocks()
  useAppStore.setState({
    repos: [repo],
    commentsCache: { [cacheKey]: { data: [original], fetchedAt: 1 } }
  })
})
afterEach(cleanup)

it('keeps the remounted opposite action pending through false settlement and permits a later retry', async () => {
  const first = Promise.withResolvers<boolean>()
  const second = Promise.withResolvers<boolean>()
  mockApi.gh.resolveReviewThread
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise)
  render(<Panel />)
  fireEvent.click(screen.getByRole('button', { name: 'Resolved · 1' }))
  const unresolveButton = screen.getByRole('button', { name: 'Unresolve' })
  fireEvent.click(unresolveButton)
  expect(mockApi.gh.resolveReviewThread).toHaveBeenCalledTimes(1)
  expect(screen.getByTestId('panel-resolution').textContent).toBe('false')
  expect(document.contains(unresolveButton)).toBe(false)
  const resolveButton = screen.getByRole('button', { name: 'Resolve' })
  expect(resolveButton.hasAttribute('disabled')).toBe(true)
  fireEvent.click(resolveButton)
  expect(mockApi.gh.resolveReviewThread).toHaveBeenCalledTimes(1)
  expect(screen.getByTestId('panel-resolution').textContent).toBe('false')
  expect(toast.error).not.toHaveBeenCalled()
  await act(async () => {
    first.resolve(false)
    await first.promise
  })
  expect(screen.getByTestId('panel-resolution').textContent).toBe('true')
  expect(useAppStore.getState().commentsCache[cacheKey]?.data?.[0].isResolved).toBe(true)
  expect(toast.error).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'Resolved · 1' }))
  const retry = screen.getByRole('button', { name: 'Unresolve' })
  expect(retry.hasAttribute('disabled')).toBe(false)
  fireEvent.click(retry)
  expect(mockApi.gh.resolveReviewThread).toHaveBeenCalledTimes(2)
  await act(async () => {
    second.resolve(false)
    await second.promise
  })
  expect(screen.getByTestId('panel-resolution').textContent).toBe('true')
  expect(useAppStore.getState().commentsCache[cacheKey]?.data?.[0].isResolved).toBe(true)
})

it('keeps the transport owner after the panel unmounts', async () => {
  const host = Promise.withResolvers<boolean>()
  mockApi.gh.resolveReviewThread.mockReturnValueOnce(host.promise)
  const panel = render(<Panel />)
  fireEvent.click(screen.getByRole('button', { name: 'Resolved · 1' }))
  fireEvent.click(screen.getByRole('button', { name: 'Unresolve' }))
  panel.unmount()
  await expect(
    useAppStore
      .getState()
      .resolveReviewThread(repo.path, 12, threadId, true, { repoId: repo.id, prRepo: pr.prRepo })
  ).resolves.toBe('busy')
  expect(mockApi.gh.resolveReviewThread).toHaveBeenCalledTimes(1)
  await act(async () => {
    host.resolve(false)
    await host.promise
  })
  mockApi.gh.resolveReviewThread.mockResolvedValueOnce(false)
  await expect(
    useAppStore
      .getState()
      .resolveReviewThread(repo.path, 12, threadId, false, { repoId: repo.id, prRepo: pr.prRepo })
  ).resolves.toBe(false)
  expect(mockApi.gh.resolveReviewThread).toHaveBeenCalledTimes(2)
})

it('restores the same thread after head and optional repository metadata change during ordinary failure', async () => {
  const host = Promise.withResolvers<boolean>()
  mockApi.gh.resolveReviewThread.mockReturnValueOnce(host.promise)
  const panel = render(<Panel />)
  fireEvent.click(screen.getByRole('button', { name: 'Resolved · 1' }))
  fireEvent.click(screen.getByRole('button', { name: 'Unresolve' }))
  panel.rerender(<Panel prValue={makePR({ ...pr, headSha: 'new-head', prRepo: undefined })} />)
  expect(screen.getByRole('button', { name: 'Resolve' }).hasAttribute('disabled')).toBe(true)
  await act(async () => {
    host.resolve(false)
    await host.promise
  })
  expect(screen.getByTestId('panel-resolution').textContent).toBe('true')
  expect(useAppStore.getState().commentsCache[cacheKey]?.data?.[0].isResolved).toBe(true)
})

it('does not roll an old failure into another current review with the same thread id', async () => {
  const host = Promise.withResolvers<boolean>()
  mockApi.gh.resolveReviewThread.mockReturnValueOnce(host.promise)
  const panel = render(<Panel />)
  fireEvent.click(screen.getByRole('button', { name: 'Resolved · 1' }))
  fireEvent.click(screen.getByRole('button', { name: 'Unresolve' }))
  panel.rerender(<Panel prValue={makePR({ ...pr, number: 13 })} />)
  expect(screen.getByRole('button', { name: 'Resolve' }).hasAttribute('disabled')).toBe(false)
  await act(async () => {
    host.resolve(false)
    await host.promise
  })
  expect(screen.getByTestId('panel-resolution').textContent).toBe('false')
  expect(useAppStore.getState().commentsCache[cacheKey]?.data?.[0].isResolved).toBe(true)
})

it('disables the same canonical thread on another mounted panel until ordinary failure settles', async () => {
  const host = Promise.withResolvers<boolean>()
  mockApi.gh.resolveReviewThread.mockReturnValueOnce(host.promise)
  render(
    <>
      <section aria-label="first panel">
        <Panel />
      </section>
      <section aria-label="second panel">
        <Panel />
      </section>
    </>
  )
  const first = within(screen.getByRole('region', { name: 'first panel' }))
  const second = within(screen.getByRole('region', { name: 'second panel' }))
  fireEvent.click(first.getByRole('button', { name: 'Resolved · 1' }))
  fireEvent.click(second.getByRole('button', { name: 'Resolved · 1' }))
  fireEvent.click(first.getByRole('button', { name: 'Unresolve' }))
  const duplicate = second.getByRole('button', { name: 'Unresolve' })
  expect(duplicate.hasAttribute('disabled')).toBe(true)
  fireEvent.click(duplicate)
  expect(mockApi.gh.resolveReviewThread).toHaveBeenCalledTimes(1)
  await act(async () => {
    host.resolve(false)
    await host.promise
  })
  expect(second.getByRole('button', { name: 'Unresolve' }).hasAttribute('disabled')).toBe(false)
})
