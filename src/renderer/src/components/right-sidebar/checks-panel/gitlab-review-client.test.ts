import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import {
  gitlabReviewThreadRequest,
  resolveGitlabReviewThread
} from '@/runtime/review-thread-resolution'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitLabWorkItemDetails } from '../../../../../shared/gitlab-types'

const runtime = vi.hoisted(() => ({ call: vi.fn() }))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: runtime.call,
  runtimeEnvironmentSupportsCapability: vi.fn()
}))

import {
  fetchGitLabMRDetailsForChecks,
  gitLabMRCommentsToPRComments,
  resolveGitLabMRDiscussionForChecks
} from './gitlab-review-client'

const gl = { workItemDetails: vi.fn(), resolveMRDiscussion: vi.fn() }

beforeEach(() => {
  runtime.call.mockReset()
  runtime.call.mockResolvedValue(null)
  gl.workItemDetails.mockReset().mockResolvedValue(null)
  gl.resolveMRDiscussion.mockReset().mockResolvedValue({ ok: true })
  vi.stubGlobal('window', { api: { gl } })
})

describe('GitLab checks-panel provider adapter', () => {
  it('reads an SSH workspace MR on this computer, never the focused server (#24264)', async () => {
    await fetchGitLabMRDetailsForChecks({
      repoPath: '/workspace/repo',
      repoId: 'repo-1',
      iid: 17,
      repoOwnerExecutionHostId: 'ssh:devbox'
    })
    await resolveGitLabMRDiscussionForChecks({
      repoPath: '/workspace/repo',
      repoId: 'repo-1',
      iid: 17,
      discussionId: 'discussion-4',
      resolved: true,
      repoOwnerExecutionHostId: 'ssh:devbox'
    })

    expect(runtime.call).not.toHaveBeenCalled()
    expect(gl.workItemDetails).toHaveBeenCalledWith({
      repoPath: '/workspace/repo',
      repoId: 'repo-1',
      repoOwnerExecutionHostId: 'ssh:devbox',
      iid: 17,
      type: 'mr',
      includeReviewDetails: false
    })
    expect(gl.resolveMRDiscussion).toHaveBeenCalledOnce()
  })

  it('reads a server-owned workspace MR on its owner with the 30 second timeout', async () => {
    await fetchGitLabMRDetailsForChecks({
      repoPath: '/workspace/repo',
      repoId: 'repo-1',
      iid: 17,
      repoOwnerExecutionHostId: 'runtime:owner-runtime'
    })

    expect(gl.workItemDetails).not.toHaveBeenCalled()
    expect(runtime.call).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'owner-runtime' },
      'gitlab.workItemDetails',
      expect.objectContaining({
        repo: 'id:repo-1',
        iid: 17,
        type: 'mr',
        includeReviewDetails: false
      }),
      { timeoutMs: 30_000 }
    )
  })

  it('removes open-ended GitLab reactions before rendering shared comments', () => {
    const comments: GitLabWorkItemDetails['comments'] = [
      {
        id: 9,
        author: 'reviewer',
        authorAvatarUrl: 'https://gitlab.example/avatar.png',
        body: 'Please update this.',
        createdAt: '2026-01-01T00:00:00Z',
        url: 'https://gitlab.example/comment/9',
        reactions: [{ name: 'custom-award', count: 2 }]
      }
    ]

    expect(gitLabMRCommentsToPRComments(comments)).toEqual([
      {
        id: 9,
        author: 'reviewer',
        authorAvatarUrl: 'https://gitlab.example/avatar.png',
        body: 'Please update this.',
        createdAt: '2026-01-01T00:00:00Z',
        url: 'https://gitlab.example/comment/9'
      }
    ])
  })
})

it('shares admission for equivalent Checks and source routes, preserves source guards, and retires after failure', async () => {
  const sourceContext: TaskSourceContext = {
    kind: 'task-source',
    provider: 'gitlab',
    projectId: 'project',
    repoId: 'repo-1',
    hostId: 'ssh:devbox'
  }
  const selector = {
    repoPath: '/repo',
    repoId: 'repo-1',
    sourceContext,
    repoOwnerExecutionHostId: 'ssh:devbox'
  }
  const request = gitlabReviewThreadRequest(selector, 17, 'discussion')
  const equivalent = gitlabReviewThreadRequest(
    { ...selector, sourceContext: undefined },
    17,
    'discussion'
  )
  expect(equivalent.key).toBe(request.key)
  const host = Promise.withResolvers<{ ok: false; error: string }>()
  gl.resolveMRDiscussion.mockReturnValueOnce(host.promise).mockResolvedValueOnce({ ok: true })
  const first = resolveGitlabReviewThread(request, false)
  await expect(
    resolveGitLabMRDiscussionForChecks({
      repoPath: '/repo',
      repoId: 'repo-1',
      iid: 17,
      discussionId: 'discussion',
      resolved: true,
      repoOwnerExecutionHostId: 'ssh:devbox'
    })
  ).resolves.toBe('busy')
  expect(gl.resolveMRDiscussion).toHaveBeenCalledExactlyOnceWith({
    ...selector,
    iid: 17,
    discussionId: 'discussion',
    resolved: false
  })
  host.resolve({ ok: false, error: 'refused' })
  await expect(first).resolves.toEqual({ ok: false, error: 'refused' })
  await expect(resolveGitlabReviewThread(equivalent, true)).resolves.toEqual({ ok: true })
})

it('keeps actual local and SSH owner endpoints independent and ignores account labels', () => {
  const sourceContext: TaskSourceContext = {
    kind: 'task-source',
    provider: 'gitlab',
    projectId: 'project',
    repoId: 'repo-1',
    hostId: 'local'
  }
  const local = gitlabReviewThreadRequest(
    { repoPath: '/repo', repoId: 'repo-1', sourceContext },
    17,
    'discussion'
  )
  const relabeled = gitlabReviewThreadRequest(
    {
      repoPath: '/repo',
      repoId: 'repo-1',
      sourceContext: { ...sourceContext, projectId: 'other', accountLabel: 'other' }
    },
    17,
    'discussion'
  )
  const ssh = gitlabReviewThreadRequest(
    { repoPath: '/repo', repoId: 'repo-1', repoOwnerExecutionHostId: 'ssh:devbox' },
    17,
    'discussion'
  )
  expect(local.key).toBe(relabeled.key)
  expect(ssh.key).not.toBe(local.key)
})

it('keeps unknown-owner key lookup safe and preserves asynchronous routing refusal on every retry', async () => {
  const request = gitlabReviewThreadRequest(
    { repoPath: '/repo', repoId: 'repo-1', repoOwnerExecutionHostId: 'runtime:unresolved-owner' },
    17,
    'discussion'
  )
  await expect(resolveGitlabReviewThread(request, true)).rejects.toThrow('not known yet')
  await expect(resolveGitlabReviewThread(request, false)).rejects.toThrow('not known yet')
  expect(gl.resolveMRDiscussion).not.toHaveBeenCalled()
  expect(runtime.call).not.toHaveBeenCalled()
})

it('preserves runtime source repo routing and cleans up an offline owner without falling back locally', async () => {
  const sourceContext: TaskSourceContext = {
    kind: 'task-source',
    provider: 'gitlab',
    projectId: 'project',
    repoId: 'server-repo',
    hostId: 'runtime:owner'
  }
  const request = gitlabReviewThreadRequest(
    {
      repoPath: '/repo',
      repoId: 'client-repo',
      sourceContext,
      repoOwnerExecutionHostId: 'runtime:owner'
    },
    17,
    'discussion'
  )
  const owned = gitlabReviewThreadRequest(
    { repoPath: '/repo', repoId: 'server-repo', repoOwnerExecutionHostId: 'runtime:owner' },
    17,
    'discussion'
  )
  expect(request.key).toBe(owned.key)
  runtime.call.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ ok: true })
  await expect(resolveGitlabReviewThread(request, false)).rejects.toThrow('offline')
  await expect(resolveGitlabReviewThread(owned, true)).resolves.toEqual({ ok: true })
  expect(gl.resolveMRDiscussion).not.toHaveBeenCalled()
  expect(runtime.call).toHaveBeenNthCalledWith(
    1,
    { kind: 'environment', environmentId: 'owner' },
    'gitlab.resolveMRDiscussion',
    expect.objectContaining({ repo: 'id:server-repo', sourceContext, discussionId: 'discussion' }),
    { timeoutMs: 30_000 }
  )
})
