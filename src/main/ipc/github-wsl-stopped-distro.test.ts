import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = await vi.hoisted(async () => {
  const { createGitHubIpcMocks } = await import('./github-ipc-module-mocks')
  return createGitHubIpcMocks()
})
const runningStateMock = vi.hoisted(() =>
  vi.fn(async (_distro: string, _options?: unknown) => 'stopped')
)

vi.mock('electron', () => mocks.electron)
vi.mock('../wsl-background-distro-gate', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readWslDistroRunningState: runningStateMock
}))
vi.mock('../github/client', () => mocks.client)
vi.mock('../github/work-item-details', () => mocks.workItemDetails)
vi.mock('../github/pr-refresh-coordinator', () => mocks.prRefresh)
vi.mock('../telemetry/client', () => mocks.telemetry)
vi.mock('../telemetry/cohort-classifier', () => mocks.cohort)
vi.mock('./ui', () => mocks.ui)

import { registerGitHubHandlers } from './github'
import { createGitHubIpcHarness, setPlatform } from './github-ipc-test-harness'
import { WslDistroStoppedError } from '../wsl/wsl-unc-access-gate'

const {
  getIssue: getIssueMock,
  listWorkItems: listWorkItemsMock,
  countWorkItems: countWorkItemsMock,
  getPRChecks: getPRChecksMock
} = mocks.client

// G1/G2: issue cards and the checks panel poll gh in the project's distro; a stopped one must stay down.
describe('background GitHub reads for a stopped WSL distro', () => {
  const harness = createGitHubIpcHarness(mocks)
  const { handlers, store, stats } = harness

  beforeEach(() => {
    harness.reset()
    runningStateMock.mockReset().mockResolvedValue('stopped')
    setPlatform('win32')
    harness.projects = [
      {
        id: 'project-1',
        displayName: 'repo',
        badgeColor: 'blue',
        sourceRepoIds: ['repo-1'],
        localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' },
        createdAt: 0,
        updatedAt: 0
      }
    ]
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The harness store and stats implement the accessors these handlers read.
    registerGitHubHandlers(store as never, stats as never)
  })

  it.each([
    ['gh:issue', { repoPath: '/workspace/repo', number: 7 }],
    ['gh:listWorkItems', { repoPath: '/workspace/repo', limit: 10 }],
    ['gh:countWorkItems', { repoPath: '/workspace/repo', query: 'is:issue' }],
    ['gh:prChecks', { repoPath: '/workspace/repo', prNumber: 3 }]
  ])('%s refuses without running gh', async (channel, args) => {
    await expect(handlers[channel](null, args)).rejects.toBeInstanceOf(WslDistroStoppedError)
    expect(runningStateMock).toHaveBeenCalledWith('Ubuntu', expect.anything())
    expect(getIssueMock).not.toHaveBeenCalled()
    expect(listWorkItemsMock).not.toHaveBeenCalled()
    expect(countWorkItemsMock).not.toHaveBeenCalled()
    expect(getPRChecksMock).not.toHaveBeenCalled()
  })

  it.each([
    ['gh:issue', { repoPath: '/workspace/repo', number: 7 }, 'Open a terminal in it to start it.'],
    ['gh:listWorkItems', { repoPath: '/workspace/repo', limit: 10 }, 'Open a terminal in it'],
    ['gh:countWorkItems', { repoPath: '/workspace/repo' }, 'Open a terminal in it'],
    // The checks panel's Refresh is a user act, so its refusal may offer Retry.
    ['gh:prChecks', { repoPath: '/workspace/repo', prNumber: 3 }, 'Retry, or open a terminal']
  ])('%s words the refusal for what its Retry can do', async (channel, args, wording) => {
    await expect(handlers[channel](null, args)).rejects.toThrow(wording)
  })

  it('runs gh once the distro is running', async () => {
    runningStateMock.mockResolvedValue('running')
    getIssueMock.mockResolvedValue(null)
    await handlers['gh:issue'](null, { repoPath: '/workspace/repo', number: 7 })
    expect(getIssueMock).toHaveBeenCalledWith('/workspace/repo', 7, null, { wslDistro: 'Ubuntu' })
  })

  it('lets an opened checks panel or its Refresh start the distro, but not the next poll', async () => {
    getPRChecksMock.mockResolvedValue([])
    const args = { repoPath: '/workspace/repo', prNumber: 3 }
    await handlers['gh:prChecks'](null, { ...args, wakeWslDistro: true })
    expect(getPRChecksMock).toHaveBeenCalledTimes(1)
    expect(runningStateMock).not.toHaveBeenCalled()

    await expect(handlers['gh:prChecks'](null, args)).rejects.toBeInstanceOf(WslDistroStoppedError)
    expect(getPRChecksMock).toHaveBeenCalledTimes(1)
  })

  it('never asks WSL about a repo that runs on the Windows host', async () => {
    harness.projects = []
    getIssueMock.mockResolvedValue(null)
    await handlers['gh:issue'](null, { repoPath: '/workspace/repo', number: 7 })
    expect(runningStateMock).not.toHaveBeenCalled()
    expect(getIssueMock).toHaveBeenCalledTimes(1)
  })
})
