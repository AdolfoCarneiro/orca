// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type { GitLabWorkItem } from '../../../../shared/gitlab-types'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import { useGitLabItemDialogState } from './use-gitlab-item-dialog-state'
import { useGitLabReviewActions } from './use-gitlab-review-actions'
import { CommentCard } from '../gitlab-item-dialog-parts'
import { resolveGitLabMRDiscussionForChecks } from '../right-sidebar/checks-panel/gitlab-review-client'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const resolveMRDiscussion = vi.fn()
const item: GitLabWorkItem = {
  id: 'mr:12',
  type: 'mr',
  number: 12,
  repoId: 'dialog-repo',
  title: 'Review',
  state: 'opened',
  url: '',
  labels: [],
  updatedAt: '',
  author: null
}
const sourceContext: TaskSourceContext = {
  kind: 'task-source',
  provider: 'gitlab',
  projectId: 'project',
  repoId: item.repoId,
  hostId: 'local'
}
const selector = {
  repoPath: '/repo',
  repoId: item.repoId,
  repoOwnerExecutionHostId: 'local',
  sourceContext
}
const comment = {
  id: 1,
  threadId: 'discussion',
  isResolved: false,
  author: 'reviewer',
  authorAvatarUrl: '',
  body: 'Review',
  url: '',
  createdAt: ''
}

beforeEach(() => {
  vi.clearAllMocks()
  resolveMRDiscussion.mockReset()
  const browserWindow = document.defaultView
  if (!browserWindow) {
    throw new Error('Missing happy-dom window')
  }
  Object.assign(browserWindow, { api: { gl: { resolveMRDiscussion } } })
  vi.stubGlobal('window', browserWindow)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('shares a pending discussion between Checks and the real dialog action/control, with a quiet refusal and later retry', async () => {
  const host = Promise.withResolvers<{ ok: false; error: string }>()
  resolveMRDiscussion
    .mockReturnValueOnce(host.promise)
    .mockResolvedValueOnce({ ok: false, error: 'refused again' })
  const first = resolveGitLabMRDiscussionForChecks({
    repoPath: '/repo',
    repoId: item.repoId,
    iid: 12,
    discussionId: 'discussion',
    resolved: true,
    repoOwnerExecutionHostId: 'local'
  })
  const hook = renderHook(() => {
    const state = useGitLabItemDialogState(item.id)
    return useGitLabReviewActions(item, selector, state)
  })
  render(
    <CommentCard
      comment={comment}
      canResolve
      pendingKey={hook.result.current.getThreadResolutionKey('discussion')}
      onResolve={(threadId, resolved) => {
        void hook.result.current.handleResolveDiscussion(threadId, resolved)
      }}
    />
  )
  const button = screen.getByRole('button', { name: 'Resolve' })
  expect(button.hasAttribute('disabled')).toBe(true)
  fireEvent.click(button)
  await act(async () => {
    await hook.result.current.handleResolveDiscussion('discussion', false)
  })
  expect(resolveMRDiscussion).toHaveBeenCalledTimes(1)
  expect(toast.error).not.toHaveBeenCalled()
  await act(async () => {
    host.resolve({ ok: false, error: 'refused' })
    await first
  })
  expect(button.hasAttribute('disabled')).toBe(false)
  await act(async () => {
    await hook.result.current.handleResolveDiscussion('discussion', true)
  })
  expect(resolveMRDiscussion).toHaveBeenCalledTimes(2)
  expect(resolveMRDiscussion).toHaveBeenLastCalledWith({
    ...selector,
    iid: 12,
    discussionId: 'discussion',
    resolved: true
  })
  expect(toast.error).toHaveBeenCalledExactlyOnceWith('refused again')
})
