import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = await vi.hoisted(async () => {
  const { createGitHubIpcMocks } = await import('./github-ipc-module-mocks')
  return createGitHubIpcMocks()
})
const readWslDistroRunningStateMock = vi.hoisted(() => vi.fn())

vi.mock('electron', () => mocks.electron)
vi.mock('../github/client', () => mocks.client)
vi.mock('../github/work-item-details', () => mocks.workItemDetails)
vi.mock('../github/pr-refresh-coordinator', () => mocks.prRefresh)
vi.mock('../telemetry/client', () => mocks.telemetry)
vi.mock('../telemetry/cohort-classifier', () => mocks.cohort)
vi.mock('./ui', () => mocks.ui)
vi.mock('../wsl-background-distro-gate', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readWslDistroRunningState: readWslDistroRunningStateMock
}))

import { registerGitHubHandlers } from './github'
import { createGitHubIpcHarness, setPlatform } from './github-ipc-test-harness'
import { WslDistroStoppedError } from '../wsl/wsl-unc-access-gate'

const { getIssue, getPRChecks, listWorkItems, countWorkItems } = mocks.client
const REPO = '/workspace/repo'

// gh with a WSL repo's cwd runs through `wsl.exe -d`, which boots a stopped distro (E9).
describe('GitHub polls for a repo in a stopped WSL distro', () => {
  const harness = createGitHubIpcHarness(mocks)
  const { handlers, store, stats } = harness

  beforeEach(() => {
    harness.reset()
    readWslDistroRunningStateMock.mockReset().mockResolvedValue('stopped')
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
    getIssue.mockResolvedValue(null)
    getPRChecks.mockResolvedValue([])
    listWorkItems.mockResolvedValue({ items: [] })
    countWorkItems.mockResolvedValue(0)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The harness store implements the accessors these handlers read.
    registerGitHubHandlers(store as never, stats as never)
  })

  it.each([
    ['gh:issue', { repoPath: REPO, number: 7 }],
    ['gh:prChecks', { repoPath: REPO, prNumber: 7 }],
    ['gh:listWorkItems', { repoPath: REPO, limit: 10 }],
    ['gh:countWorkItems', { repoPath: REPO }]
  ])('%s refuses without running gh in the distro', async (channel, args) => {
    await expect(handlers[channel](null, args)).rejects.toBeInstanceOf(WslDistroStoppedError)
    expect(readWslDistroRunningStateMock).toHaveBeenCalledWith('Ubuntu', expect.anything())
    expect(getIssue).not.toHaveBeenCalled()
    expect(getPRChecks).not.toHaveBeenCalled()
    expect(listWorkItems).not.toHaveBeenCalled()
    expect(countWorkItems).not.toHaveBeenCalled()
  })

  it('lets a checks Refresh start the distro, but not the next poll', async () => {
    await handlers['gh:prChecks'](null, { repoPath: REPO, prNumber: 7, wakeWslDistro: true })
    expect(getPRChecks).toHaveBeenCalledTimes(1)
    expect(readWslDistroRunningStateMock).not.toHaveBeenCalled()

    await expect(
      handlers['gh:prChecks'](null, { repoPath: REPO, prNumber: 7 })
    ).rejects.toBeInstanceOf(WslDistroStoppedError)
    expect(getPRChecks).toHaveBeenCalledTimes(1)
  })

  it('polls a running distro as before', async () => {
    readWslDistroRunningStateMock.mockResolvedValue('running')

    await handlers['gh:issue'](null, { repoPath: REPO, number: 7 })
    await handlers['gh:prChecks'](null, { repoPath: REPO, prNumber: 7 })

    expect(getIssue).toHaveBeenCalledWith(REPO, 7, null, { wslDistro: 'Ubuntu' })
    expect(getPRChecks).toHaveBeenCalledTimes(1)
  })

  it('never asks WSL about a repo that runs on the Windows host', async () => {
    harness.projects = []

    await handlers['gh:issue'](null, { repoPath: REPO, number: 7 })

    expect(readWslDistroRunningStateMock).not.toHaveBeenCalled()
    expect(getIssue).toHaveBeenCalledTimes(1)
  })
})
