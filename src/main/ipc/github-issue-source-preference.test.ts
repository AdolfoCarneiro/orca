import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = await vi.hoisted(async () => {
  const { createGitHubIpcMocks } = await import('./github-ipc-module-mocks')
  return createGitHubIpcMocks()
})

vi.mock('electron', () => mocks.electron)
vi.mock('../github/client', () => mocks.client)
vi.mock('../github/work-item-details', () => mocks.workItemDetails)
vi.mock('../github/pr-refresh-coordinator', () => mocks.prRefresh)
vi.mock('../telemetry/client', () => mocks.telemetry)
vi.mock('../telemetry/cohort-classifier', () => mocks.cohort)
vi.mock('./ui', () => mocks.ui)

import { registerGitHubHandlers } from './github'
import { createGitHubIpcHarness } from './github-ipc-test-harness'

const {
  listIssues: listIssuesMock,
  listWorkItems: listWorkItemsMock,
  getWorkItem: getWorkItemMock
} = mocks.client
const { getWorkItemDetails: getWorkItemDetailsMock } = mocks.workItemDetails

describe('registerGitHubHandlers', () => {
  const harness = createGitHubIpcHarness(mocks)
  const { handlers, store, stats } = harness

  beforeEach(harness.reset)

  it('strictly selects optional owners for nested replies and reactions, with legacy omitted-owner compatibility', async () => {
    const local = harness.repos[0]
    const remote = { ...local, connectionId: 'builder' }
    harness.repos = [local, remote]
    mocks.client.addPRReviewCommentReply.mockResolvedValue({ ok: false, error: 'stub' })
    mocks.client.setPRCommentReaction.mockResolvedValue(true)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture implements the repo/settings reads used by these handlers.
    registerGitHubHandlers(store as never, stats as never)
    const args = { repoPath: local.path, repoId: local.id, repoOwnerExecutionHostId: 'ssh:builder' }
    const reply = { ...args, prNumber: 12, commentId: 42, body: 'Reply' }
    const reaction = { ...args, reactionSubjectId: 'subject', content: 'heart', reacted: true }
    await handlers['gh:addPRReviewCommentReply'](null, reply)
    await handlers['gh:setPRCommentReaction'](null, reaction)
    expect(mocks.client.addPRReviewCommentReply).toHaveBeenCalledWith(
      local.path,
      12,
      42,
      'Reply',
      undefined,
      undefined,
      undefined,
      'builder',
      null
    )
    expect(mocks.client.setPRCommentReaction).toHaveBeenCalledWith(
      local.path,
      'subject',
      'heart',
      true,
      'builder',
      null
    )
    harness.repos = [local]
    await expect(handlers['gh:addPRReviewCommentReply'](null, reply)).rejects.toThrow(
      'PR comment owner does not match repository host'
    )
    expect(() => handlers['gh:setPRCommentReaction'](null, reaction)).toThrow(
      'PR comment owner does not match repository host'
    )
    expect(mocks.client.addPRReviewCommentReply).toHaveBeenCalledTimes(1)
    expect(mocks.client.setPRCommentReaction).toHaveBeenCalledTimes(1)
    await handlers['gh:addPRReviewCommentReply'](null, {
      ...reply,
      repoOwnerExecutionHostId: undefined
    })
    await handlers['gh:setPRCommentReaction'](null, {
      ...reaction,
      repoOwnerExecutionHostId: undefined
    })
    expect(mocks.client.addPRReviewCommentReply).toHaveBeenCalledTimes(2)
    expect(mocks.client.setPRCommentReaction).toHaveBeenCalledTimes(2)
  })

  it('validates optional PR comment owners for reads and PR posts while preserving issue routing', async () => {
    const local = harness.repos[0]
    const remote = { ...local, connectionId: 'builder' }
    harness.repos = [local, remote]
    mocks.client.getPRComments.mockResolvedValue([])
    mocks.client.addIssueComment.mockResolvedValue({ ok: false, error: 'stub' })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture implements all repo/settings reads used by these handlers.
    registerGitHubHandlers(store as never, stats as never)
    const args = { repoPath: local.path, repoId: local.id, repoOwnerExecutionHostId: 'ssh:builder' }
    await handlers['gh:prComments'](null, { ...args, prNumber: 12 })
    await handlers['gh:addIssueComment'](null, {
      ...args,
      number: 12,
      body: 'PR reply',
      type: 'pr'
    })
    expect(mocks.client.getPRComments).toHaveBeenCalledWith(
      local.path,
      12,
      { noCache: undefined, prRepo: null },
      'builder'
    )
    expect(mocks.client.addIssueComment).toHaveBeenLastCalledWith(
      local.path,
      12,
      'PR reply',
      'builder',
      null,
      undefined,
      undefined
    )
    harness.repos = [local]
    const reads = mocks.client.getPRComments.mock.calls.length
    const posts = mocks.client.addIssueComment.mock.calls.length
    expect(() => handlers['gh:prComments'](null, { ...args, prNumber: 12 })).toThrow(
      'PR comment owner does not match repository host'
    )
    await expect(
      handlers['gh:addIssueComment'](null, { ...args, number: 12, body: 'PR reply', type: 'pr' })
    ).rejects.toThrow('PR comment owner does not match repository host')
    expect(mocks.client.getPRComments).toHaveBeenCalledTimes(reads)
    expect(mocks.client.addIssueComment).toHaveBeenCalledTimes(posts)
    await handlers['gh:addIssueComment'](null, {
      ...args,
      number: 12,
      body: 'Issue reply',
      type: 'issue'
    })
    expect(mocks.client.addIssueComment).toHaveBeenLastCalledWith(
      local.path,
      12,
      'Issue reply',
      null,
      null,
      undefined,
      undefined
    )
    await handlers['gh:prComments'](null, { repoPath: local.path, prNumber: 12 })
    expect(mocks.client.getPRComments).toHaveBeenCalledTimes(reads + 1)
  })

  it('drops the error field from listIssues envelope at the IPC boundary', async () => {
    // Preserve legacy gh:listIssues arrays; only gh:listWorkItems exposes the richer items/error envelope.
    listIssuesMock.mockResolvedValue({
      items: [],
      error: {
        type: 'permission_denied',
        message:
          "You don't have permission to read issues for this repository. Check your GitHub token scopes."
      }
    })

    registerGitHubHandlers(store as never, stats as never)

    const result = await handlers['gh:listIssues'](null, {
      repoPath: '/workspace/repo',
      limit: 5
    })

    expect(listIssuesMock).toHaveBeenCalledWith('/workspace/repo', 5, undefined, null)
    expect(result).toEqual([])
  })

  it('threads issueSourcePreference through gh:listIssues', async () => {
    // Use a nondefault preference so missing argument forwarding cannot pass silently.
    harness.repos[0].issueSourcePreference = 'upstream'
    listIssuesMock.mockResolvedValue({ items: [] })

    registerGitHubHandlers(store as never, stats as never)

    await handlers['gh:listIssues'](null, {
      repoPath: '/workspace/repo',
      limit: 5
    })

    expect(listIssuesMock).toHaveBeenCalledWith('/workspace/repo', 5, 'upstream', null)
  })

  it('threads issueSourcePreference through gh:listWorkItems', async () => {
    harness.repos[0].issueSourcePreference = 'origin'
    listWorkItemsMock.mockResolvedValue({ items: [] })

    registerGitHubHandlers(store as never, stats as never)

    await handlers['gh:listWorkItems'](null, {
      repoPath: '/workspace/repo',
      limit: 10,
      query: 'is:open',
      page: 2,
      noCache: true
    })

    expect(listWorkItemsMock).toHaveBeenCalledWith(
      '/workspace/repo',
      10,
      'is:open',
      2,
      'origin',
      null,
      true
    )
  })

  // Open-by-number must use the listed source when origin/upstream share an item number.
  it('pins the repo origin source preference on work item and details IPC', async () => {
    harness.repos = [
      {
        id: 'repo-1',
        path: '/workspace/repo',
        displayName: 'repo',
        badgeColor: '#000',
        addedAt: 0,
        issueSourcePreference: 'origin'
      }
    ]
    getWorkItemMock.mockResolvedValue(null)
    getWorkItemDetailsMock.mockResolvedValue(null)
    registerGitHubHandlers(store as never, stats as never)

    await handlers['gh:workItem'](null, { repoPath: '/workspace/repo', number: 42, type: 'pr' })
    await handlers['gh:workItemDetails'](null, {
      repoPath: '/workspace/repo',
      number: 42,
      type: 'pr'
    })

    expect(getWorkItemMock).toHaveBeenCalledWith(
      '/workspace/repo',
      42,
      'pr',
      null,
      undefined,
      'origin'
    )
    expect(getWorkItemDetailsMock).toHaveBeenCalledWith(
      '/workspace/repo',
      42,
      'pr',
      null,
      undefined,
      'origin'
    )
  })

  it('passes the displayed repository ahead of the current source preference', async () => {
    harness.repos[0].issueSourcePreference = 'upstream'
    const ownerRepo = { owner: 'fork-owner', repo: 'widgets', host: 'github.com' }
    mocks.client.updateIssue.mockResolvedValue({ ok: false, error: 'stub' })
    getWorkItemDetailsMock.mockResolvedValue(null)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: These fixtures implement the repo methods used by the handlers; unrelated handlers are only registered.
    registerGitHubHandlers(store as never, stats as never)

    await handlers['gh:workItemDetails'](null, {
      repoPath: '/workspace/repo',
      number: 12,
      type: 'issue',
      ownerRepo
    })
    await handlers['gh:updateIssue'](null, {
      repoPath: '/workspace/repo',
      number: 12,
      updates: { body: 'Origin edit' },
      ownerRepo
    })
    await handlers['gh:listLabels'](null, { repoPath: '/workspace/repo', ownerRepo })
    await handlers['gh:listAssignableUsers'](null, { repoPath: '/workspace/repo', ownerRepo })

    expect(getWorkItemDetailsMock).toHaveBeenCalledWith(
      '/workspace/repo',
      12,
      'issue',
      null,
      undefined,
      'upstream',
      ownerRepo
    )
    expect(mocks.client.updateIssue).toHaveBeenCalledWith(
      '/workspace/repo',
      12,
      { body: 'Origin edit' },
      null,
      undefined,
      'upstream',
      ownerRepo
    )
    expect(mocks.client.listLabels).toHaveBeenCalledWith(
      '/workspace/repo',
      'upstream',
      null,
      undefined,
      ownerRepo
    )
    expect(mocks.client.listAssignableUsers).toHaveBeenCalledWith(
      '/workspace/repo',
      'upstream',
      null,
      undefined,
      ownerRepo
    )
  })

  it('pins the repo origin source preference on issue update and comment IPC', async () => {
    harness.repos = [
      {
        id: 'repo-1',
        path: '/workspace/repo',
        displayName: 'repo',
        badgeColor: '#000',
        addedAt: 0,
        issueSourcePreference: 'origin'
      }
    ]
    mocks.client.updateIssue.mockResolvedValue({ ok: false, error: 'stub' })
    mocks.client.addIssueComment.mockResolvedValue({ ok: false, error: 'stub' })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: These fixtures implement the repo methods used by the handlers; unrelated handlers are only registered.
    registerGitHubHandlers(store as never, stats as never)

    await handlers['gh:updateIssue'](null, {
      repoPath: '/workspace/repo',
      number: 5,
      updates: { body: 'Updated' }
    })
    await handlers['gh:addIssueComment'](null, {
      repoPath: '/workspace/repo',
      number: 5,
      body: 'Issue comment'
    })
    await handlers['gh:addIssueComment'](null, {
      repoPath: '/workspace/repo',
      number: 6,
      body: 'PR comment',
      type: 'pr'
    })

    expect(mocks.client.updateIssue).toHaveBeenCalledWith(
      '/workspace/repo',
      5,
      { body: 'Updated' },
      null,
      undefined,
      'origin'
    )
    expect(mocks.client.addIssueComment).toHaveBeenNthCalledWith(
      1,
      '/workspace/repo',
      5,
      'Issue comment',
      null,
      null,
      undefined,
      'origin'
    )
    expect(mocks.client.addIssueComment).toHaveBeenNthCalledWith(
      2,
      '/workspace/repo',
      6,
      'PR comment',
      null,
      null,
      undefined,
      undefined
    )
  })
})
