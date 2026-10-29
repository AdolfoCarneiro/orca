import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WorkItem } from '../../../shared/rpc-contract/github-repo-work-item-params'
import type { GitHubWorkItemDetails } from '../../../shared/github/work-item-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import { GitHubWorkItemTargetError } from '../../../shared/github/work-item-target'
import { GITHUB_EXACT_WORK_ITEM_TARGET_RUNTIME_CAPABILITY } from '../../../shared/source-control-runtime-capabilities'
import { lookupGitHubWorkItemDetailsForSource } from './github-work-item-source-lookup'
import { prepareGitHubWorkItemTargetRequest } from './github-work-item-target-request'
import { settleWorkItemDetailsFetch } from '@/components/github-item-dialog/load-item-details/work-item-details-fetch-settle'
import {
  touchWorkItemDetailsCache,
  workItemDetailsCache,
  workItemDetailsCacheGeneration,
  getWorkItemDetailsCacheKey
} from '@/components/github-item-dialog/load-item-details/work-item-details-cache'
import { runIssueUpdate } from '@/components/github/github-work-item-edit-mutations'
import { createGitHubApi } from '@/web/preload-api/web-github-api'

const server = vi.hoisted(() => ({ capable: false, rpc: vi.fn(), web: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: server.rpc,
  runtimeEnvironmentSupportsCapability: async () => server.capable
}))
vi.mock('@/runtime/local-runtime-capabilities', () => ({
  ensureLocalRuntimeCapabilities: async () => []
}))
vi.mock('@/web/preload-api/web-runtime-calls', () => ({
  callRuntimeResult: server.web,
  getRemoteRuntimeStatus: async () => ({
    capabilities: server.capable ? ['github.exact-work-item-target.v1'] : []
  })
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({ repos: [] }) } }))

const repository = { owner: 'fork', repo: 'widgets', host: 'github.corp' }
const resource = { repository, type: 'pr' as const, number: 93 }
const sourceContext: TaskSourceContext = {
  kind: 'task-source',
  provider: 'github',
  projectId: 'project',
  repoId: 'remote-clone',
  hostId: 'runtime:paired'
}
const args = {
  repoPath: '',
  repoId: 'clone',
  number: 93,
  type: 'pr' as const,
  sourceContext,
  ownerRepo: repository
}
function details(owner: string): GitHubWorkItemDetails {
  return {
    item: {
      id: 'pr:93',
      type: 'pr',
      number: 93,
      title: owner,
      state: 'open',
      labels: [],
      updatedAt: '',
      author: null,
      url: `https://github.corp/${owner}/widgets/pull/93`,
      prRepo: { ...repository, owner }
    },
    body: `${owner} body`,
    comments: [],
    pullRequestId: `PR_${owner}`
  }
}
beforeEach(() => {
  server.capable = false
  server.rpc.mockReset()
  server.web.mockReset()
  workItemDetailsCache.clear()
  vi.stubGlobal('window', {
    api: { gh: { notifyWorkItemMutated: vi.fn().mockResolvedValue(true) } }
  })
})

afterEach(() => vi.unstubAllGlobals())

it('contains an old schema that strips the target, clears rejected content and refuses unsafe writes', async () => {
  server.rpc.mockImplementation(async (_target, method, params) => {
    expect(method).toBe('github.workItemDetails')
    // This is the shipped old details schema, not the new optional-target schema.
    const old = WorkItem.parse({ ...params, ownerRepo: repository })
    expect(old).not.toHaveProperty('ownerRepo')
    return details('upstream')
  })
  const key = getWorkItemDetailsCacheKey({ ...args, issueSourcePreference: 'upstream' })
  const otherKey = getWorkItemDetailsCacheKey({
    ...args,
    ownerRepo: { ...repository, owner: 'upstream' },
    issueSourcePreference: 'upstream'
  })
  expect(key).not.toBe(otherKey)
  const inflight = lookupGitHubWorkItemDetailsForSource(args)
  touchWorkItemDetailsCache(key, {
    details: details('upstream'),
    fetchedAt: Date.now(),
    pending: inflight
  })
  settleWorkItemDetailsFetch({
    detailsCacheKey: key,
    inflight,
    launchedAtGeneration: workItemDetailsCacheGeneration
  })
  await expect(inflight).rejects.toBeInstanceOf(GitHubWorkItemTargetError)
  await Promise.resolve()
  expect(workItemDetailsCache.get(key)).toMatchObject({
    details: null,
    error: expect.stringContaining('fork/widgets#93')
  })
  expect(server.rpc).toHaveBeenCalledWith(
    expect.anything(),
    'github.workItemDetails',
    { repo: 'remote-clone', number: 93, type: 'pr' },
    expect.anything()
  )
  await expect(
    prepareGitHubWorkItemTargetRequest({
      target: { kind: 'environment', environmentId: 'paired' },
      resource,
      repoPath: '',
      repoId: 'clone',
      sourceContext
    })
  ).rejects.toBeInstanceOf(GitHubWorkItemTargetError)
  await expect(
    runIssueUpdate({
      repoPath: '',
      repoId: 'clone',
      sourceContext,
      projectOrigin: undefined,
      issueRepo: repository,
      type: 'pr',
      number: 93,
      updates: { addAssignees: ['someone'] }
    })
  ).rejects.toBeInstanceOf(GitHubWorkItemTargetError)
  expect(server.rpc.mock.calls.every(([, method]) => method === 'github.workItemDetails')).toBe(
    true
  )
})

it('accepts a matching legacy response, but not missing or contradictory identity', async () => {
  server.rpc.mockResolvedValue(details('fork'))
  await expect(lookupGitHubWorkItemDetailsForSource(args)).resolves.toMatchObject({
    body: 'fork body'
  })
  await expect(
    prepareGitHubWorkItemTargetRequest({
      target: { kind: 'environment', environmentId: 'paired' },
      resource,
      repoPath: '',
      repoId: 'clone',
      sourceContext
    })
  ).resolves.toEqual({})
  server.rpc.mockImplementation(async (_target, method) =>
    method === 'github.workItemDetails' ? details('fork') : { ok: true }
  )
  await runIssueUpdate({
    repoPath: '',
    repoId: 'clone',
    sourceContext,
    projectOrigin: undefined,
    issueRepo: repository,
    type: 'pr',
    number: 93,
    updates: { addAssignees: ['someone'] }
  })
  expect(server.rpc).toHaveBeenLastCalledWith(
    expect.anything(),
    'github.updateIssue',
    { repo: 'remote-clone', number: 93, updates: { addAssignees: ['someone'] } },
    expect.anything()
  )
  for (const patch of [
    { url: '' },
    { number: 94 },
    { type: 'issue' },
    { prRepo: { ...repository, owner: 'upstream' } },
    { url: 'https://github.com/fork/widgets/pull/93' }
  ]) {
    const result = details('fork')
    server.rpc.mockResolvedValue({ ...result, item: { ...result.item, ...patch } })
    await expect(lookupGitHubWorkItemDetailsForSource(args)).rejects.toBeInstanceOf(
      GitHubWorkItemTargetError
    )
  }
})

it('sends exact targets only to capable servers, including the web/phone adapter', async () => {
  server.capable = true
  server.rpc.mockResolvedValue(details('fork'))
  await lookupGitHubWorkItemDetailsForSource(args)
  expect(server.rpc).toHaveBeenCalledWith(
    expect.anything(),
    'github.workItemDetails',
    expect.objectContaining({ ownerRepo: repository }),
    expect.anything()
  )
  server.web.mockResolvedValue(details('fork'))
  const web = createGitHubApi()
  await expect(web.workItemDetails(args)).resolves.toMatchObject({ body: 'fork body' })
  expect(server.web).toHaveBeenLastCalledWith(
    'github.workItemDetails',
    expect.objectContaining({ ownerRepo: repository })
  )
  server.capable = false
  server.web.mockResolvedValue(details('upstream'))
  await expect(web.workItemDetails(args)).rejects.toBeInstanceOf(GitHubWorkItemTargetError)
  expect(server.web.mock.calls.at(-1)?.[1]).not.toHaveProperty('ownerRepo')
  expect(GITHUB_EXACT_WORK_ITEM_TARGET_RUNTIME_CAPABILITY).toBe('github.exact-work-item-target.v1')
})
