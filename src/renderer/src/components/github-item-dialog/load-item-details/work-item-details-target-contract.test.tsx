// @vitest-environment happy-dom
import { listLabels } from '../../../../../main/github/issue-field-options'
import { useRepoLabels } from '@/hooks/useGitHubRepoMetadata'
import { GitHubWorkItemTargetContext } from './github-work-item-target-context'
import { updateIssue } from '../../../../../main/github/issue-update'
import { runIssueUpdate } from '@/components/github/github-work-item-edit-mutations'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import { WorkItemDetails } from '../../../../../shared/rpc-contract/github-repo-work-item-params'
import { getWorkItemDetails } from '../../../../../main/github/work-item-details'
import { _resetOriginGitHubApiRepositoryCache } from '../../../../../main/github/github-api-repository'
import { useGitHubItemDialogDetails } from './use-github-item-dialog-details'
import {
  getWorkItemDetailsCacheKey,
  touchWorkItemDetailsCache,
  workItemDetailsCache
} from './work-item-details-cache'

const io = vi.hoisted(() => ({
  gh: vi.fn(),
  host: 'github.com',
  capable: true,
  rpc: vi.fn(),
  setViewed: vi.fn()
}))
vi.mock('../../../../../main/github/gh-utils', () => ({
  ghExecFileAsync: io.gh,
  acquire: vi.fn(),
  release: vi.fn(),
  ghRepoExecOptions: (context: object) => context,
  githubRepoContext: (repoPath: string) => ({ cwd: repoPath }),
  getOwnerRepoForRemote: async (_path: string, remote: string) =>
    io.host === 'github.com'
      ? { owner: remote === 'origin' ? 'fork' : 'upstream', repo: 'widgets' }
      : null
}))
vi.mock('../../../../../main/github/github-enterprise-repository', () => ({
  getEnterpriseGitHubRepoSlug: async () => ({ owner: 'fork', repo: 'widgets', host: io.host }),
  getEnterpriseGitHubRepoSlugForRemote: async () => ({
    owner: 'upstream',
    repo: 'widgets',
    host: io.host
  }),
  isGitHubHostAuthenticated: async () => true
}))
vi.mock('../../../../../main/git/remote-name-listing', () => ({
  shouldProbeGitRemote: async () => true
}))
vi.mock('../../../../../main/github/rate-limit', () => ({
  repositoryRateLimitGuard: () => ({ blocked: false }),
  noteRepositoryRateLimitSpend: vi.fn(),
  spendsSharedGitHubComQuota: () => false
}))
vi.mock('../../../../../main/github/client', async () => ({
  ...(await import('../../../../../main/github/client/fetch/get-work-item')),
  ...(await import('../../../../../main/github/client/check/get-pr-checks')),
  ...(await import('../../../../../main/github/client/fetch/get-pr-comments'))
}))
vi.mock('@/store', () => {
  const state = { repos: [{ id: 'clone', path: '/clone', issueSourcePreference: 'upstream' }] }
  return {
    useAppStore: Object.assign((select: (value: typeof state) => unknown) => select(state), {
      getState: () => state
    })
  }
})
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: io.rpc,
  runtimeEnvironmentSupportsCapability: async () => io.capable
}))
vi.mock('@/runtime/local-runtime-capabilities', () => ({
  ensureLocalRuntimeCapabilities: async () => ['github.exact-work-item-target.v1']
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

function response(value: unknown) {
  return { stdout: JSON.stringify(value) }
}
function item(owner: string): GitHubWorkItem {
  return {
    id: 'pr:93',
    repoId: 'clone',
    type: 'pr',
    number: 93,
    title: owner,
    url: `https://${io.host}/${owner}/widgets/pull/93`,
    prRepo: { owner, repo: 'widgets', host: io.host },
    state: 'open',
    labels: [],
    author: null,
    updatedAt: ''
  }
}
let labels: ReturnType<typeof useRepoLabels>
function Metadata({ enabled }: { enabled: boolean }) {
  labels = useRepoLabels(enabled ? '/clone' : null, enabled ? 'clone' : null)
  return null
}
let view: ReturnType<typeof useGitHubItemDialogDetails>
let root: ReturnType<typeof createRoot>
function Probe({
  opened,
  sourceContext,
  metadataEnabled = true
}: {
  opened: GitHubWorkItem
  sourceContext?: TaskSourceContext
  metadataEnabled?: boolean
}) {
  view = useGitHubItemDialogDetails({
    workItem: opened,
    repoPath: '/clone',
    effectiveRepoId: 'clone',
    sourceContext
  })
  return (
    <GitHubWorkItemTargetContext.Provider value={view.targetContext}>
      <Metadata enabled={metadataEnabled} />
    </GitHubWorkItemTargetContext.Provider>
  )
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  _resetOriginGitHubApiRepositoryCache()
  workItemDetailsCache.clear()
  io.capable = true
  io.rpc.mockReset()
  io.gh.mockReset().mockImplementation(async (args: string[]) => {
    const owner =
      args.includes('fork/widgets') ||
      args.includes('owner=fork') ||
      args.some((a) => a.startsWith('repos/fork/'))
        ? 'fork'
        : 'upstream'
    const query = args.find((a) => a.startsWith('query=')) ?? ''
    if (args.some((a) => a.endsWith('/labels'))) {
      return { stdout: `${owner}-label` }
    }
    if (args[0] === 'pr') {
      {
        return response(item(owner))
      }
    }
    if (query.includes('viewerViewedState')) {
      return response({
        data: {
          repository: {
            pullRequest: { participants: { nodes: [] } },
            viewedPullRequest: {
              id: `PR_${owner}`,
              files: {
                nodes: [{ path: `${owner}.ts`, viewerViewedState: 'UNVIEWED' }],
                pageInfo: { hasNextPage: false }
              }
            }
          }
        }
      })
    }
    if (query.includes('reviewThreads')) {
      return response({
        data: {
          repository: {
            pullRequest: {
              comments: {
                nodes: [
                  {
                    id: `COMMENT_${owner}`,
                    databaseId: 1,
                    author: null,
                    body: `${owner} conversation`,
                    createdAt: '2026-10-28',
                    url: item(owner).url
                  }
                ]
              },
              reviews: { nodes: [] },
              reviewThreads: { nodes: [] }
            }
          }
        }
      })
    }
    if (query.includes('statusCheckRollup')) {
      return response({
        data: {
          repository: {
            pullRequest: {
              commits: {
                nodes: [
                  {
                    commit: {
                      statusCheckRollup: {
                        contexts: {
                          nodes: [
                            {
                              __typename: 'CheckRun',
                              name: `${owner} check`,
                              status: 'COMPLETED',
                              conclusion: 'SUCCESS'
                            }
                          ]
                        }
                      }
                    }
                  }
                ]
              }
            }
          }
        }
      })
    }
    if (args.some((a) => a.includes('/files?'))) {
      return response([
        {
          filename: `${owner}.ts`,
          status: 'modified',
          additions: 1,
          deletions: 0,
          changes: 1,
          patch: '@@ -1 +1 @@\n-a\n+b'
        }
      ])
    }
    if (args.some((a) => a.endsWith('/pulls/93'))) {
      return response({
        body: `${owner} body`,
        head: { sha: `${owner}-head` },
        base: { sha: `${owner}-base` }
      })
    }
    return response({ data: { repository: {} } })
  })
  io.setViewed.mockReset().mockResolvedValue(true)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      gh: {
        workItemDetails: async (args: Parameters<typeof window.api.gh.workItemDetails>[0]) => {
          const parsed = WorkItemDetails.parse({ repo: args.repoId, ...args })
          return getWorkItemDetails(
            args.repoPath,
            parsed.number,
            parsed.type,
            null,
            {},
            'upstream',
            parsed.ownerRepo
          )
        },
        listLabels: async (args: Parameters<typeof window.api.gh.listLabels>[0]) =>
          listLabels(args.repoPath, 'upstream', null, {}, args.ownerRepo),
        updateIssue: async (args: Parameters<typeof window.api.gh.updateIssue>[0]) =>
          updateIssue(
            args.repoPath,
            args.number,
            args.updates,
            null,
            {},
            'upstream',
            args.ownerRepo
          ),
        notifyWorkItemMutated: vi.fn().mockResolvedValue(true),
        setPRFileViewed: io.setViewed
      }
    }
  })
  root = createRoot(document.createElement('div'))
})
afterEach(() => {
  act(() => root.unmount())
  vi.unstubAllGlobals()
})

it.each(['github.com', 'github.corp'])(
  'keeps %s fork details and viewed node IDs together through the real details path',
  async (host) => {
    io.host = host
    const opened = item('fork')
    const upstream = await getWorkItemDetails('/clone', 93, 'pr')
    expect(upstream?.body).toBe('upstream body')
    const key = getWorkItemDetailsCacheKey({
      repoPath: '/clone',
      repoId: 'clone',
      issueSourcePreference: 'upstream',
      type: 'pr',
      number: 93,
      ownerRepo: opened.prRepo
    })
    touchWorkItemDetailsCache(key, { details: upstream, fetchedAt: Date.now() })
    io.gh.mockClear()
    // A reused, wrongly keyed entry must be rejected before the first paint.
    let firstDetails: typeof upstream | undefined
    function FirstPaint() {
      const content = Probe({ opened })
      if (firstDetails === undefined) {
        firstDetails = view.details
      }
      return content
    }
    await act(async () => root.render(<FirstPaint />))
    expect(firstDetails).toBeNull()
    expect(view.error).toBeNull()
    expect(labels.data).toEqual(['fork-label'])
    expect(view.details).toMatchObject({
      body: 'fork body',
      headSha: 'fork-head',
      baseSha: 'fork-base',
      pullRequestId: 'PR_fork',
      files: [{ path: 'fork.ts' }],
      comments: [{ body: 'fork conversation' }],
      checks: [{ name: 'fork check' }]
    })
    expect(io.gh.mock.calls.every(([, options]) => options.host === host)).toBe(true)
    expect(view.displayWorkItem).toMatchObject({ url: opened.url, prRepo: opened.prRepo })
    expect(
      io.gh.mock.calls.some(
        ([args]) =>
          args.includes('upstream/widgets') ||
          args.includes('owner=upstream') ||
          args.some((a: string) => a.startsWith('repos/upstream/'))
      )
    ).toBe(false)
    await act(async () => {
      expect(await view.handlePRFileViewedChange('fork.ts', true)).toBe(true)
    })
    await runIssueUpdate({
      repoPath: '/clone',
      repoId: 'clone',
      projectOrigin: undefined,
      issueRepo: opened.prRepo,
      type: 'pr',
      number: 93,
      updates: { addAssignees: ['someone'] }
    })
    expect(io.gh).toHaveBeenCalledWith(
      ['issue', 'edit', '93', '--repo', 'fork/widgets', '--add-assignee', 'someone'],
      expect.objectContaining({ host })
    )
    expect(io.setViewed).toHaveBeenCalledWith(
      expect.objectContaining({ pullRequestId: 'PR_fork', prRepo: opened.prRepo, path: 'fork.ts' })
    )
  }
)

it('rechecks legacy resolution for metadata and reports one details error after the server changes source', async () => {
  io.host = 'github.com'
  io.capable = false
  const opened = item('fork')
  const sourceContext: TaskSourceContext = {
    kind: 'task-source',
    provider: 'github',
    projectId: 'project',
    repoId: 'remote-clone',
    hostId: 'runtime:paired'
  }
  const fork = await getWorkItemDetails('/clone', 93, 'pr', null, {}, 'upstream', opened.prRepo)
  io.rpc.mockResolvedValue(fork)
  await act(async () =>
    root.render(<Probe opened={opened} sourceContext={sourceContext} metadataEnabled={false} />)
  )
  expect(view.details?.body).toBe('fork body')
  io.rpc.mockResolvedValue(await getWorkItemDetails('/clone', 93, 'pr'))
  await act(async () =>
    root.render(<Probe opened={opened} sourceContext={sourceContext} metadataEnabled />)
  )
  expect(view.details).toBeNull()
  expect(view.error).toContain('fork/widgets#93')
  expect(labels.data).toEqual([])
  expect(io.rpc.mock.calls.every(([, method]) => method === 'github.workItemDetails')).toBe(true)
})
