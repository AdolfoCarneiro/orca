import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as BackgroundDistroGate from './wsl-background-distro-gate'
import type * as NodeFs from 'node:fs'

const mocks = vi.hoisted(() => ({
  readWslDistroRunningState: vi.fn(),
  existsSync: vi.fn((_path: string) => false),
  loadHooks: vi.fn((_path: string) => null)
}))

vi.mock('./wsl-background-distro-gate', async (importOriginal) => ({
  ...(await importOriginal<typeof BackgroundDistroGate>()),
  readWslDistroRunningState: mocks.readWslDistroRunningState
}))
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFs>()),
  existsSync: mocks.existsSync
}))
vi.mock('./hooks', () => ({ loadHooks: mocks.loadHooks }))

import { readIssueCommandUnlessWslStopped } from './issue-command-file'
import { RuntimeRepositoryIssueCommand } from './runtime/runtime-repository-issue-command'

const WSL_REPO = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'
const HOST_REPO = 'C:\\src\\repo'

describe('issue command reads for a stopped WSL distro (E9)', () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    mocks.readWslDistroRunningState.mockReset().mockResolvedValue('stopped')
    mocks.existsSync.mockClear()
    mocks.loadHooks.mockClear()
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
  })

  it('returns the unreachable result for a background read, never touching the distro', async () => {
    await expect(readIssueCommandUnlessWslStopped(WSL_REPO)).resolves.toMatchObject({
      status: 'error',
      localContent: null,
      sharedContent: null,
      effectiveContent: null,
      source: 'none',
      localFilePath: expect.stringContaining('issue-command')
    })
    expect(mocks.existsSync).not.toHaveBeenCalled()
    expect(mocks.loadHooks).not.toHaveBeenCalled()
  })

  it('reads for a launch, a user act that may start the distro', async () => {
    const result = await readIssueCommandUnlessWslStopped(WSL_REPO, { wakeWslDistro: true })
    expect(result).not.toHaveProperty('status')
    expect(mocks.existsSync).toHaveBeenCalled()
    expect(mocks.loadHooks).toHaveBeenCalledWith(WSL_REPO)
  })

  it('reads host repos and running distros as before', async () => {
    await readIssueCommandUnlessWslStopped(HOST_REPO)
    expect(mocks.loadHooks).toHaveBeenCalledWith(HOST_REPO)
    mocks.readWslDistroRunningState.mockResolvedValue('running')
    await readIssueCommandUnlessWslStopped(WSL_REPO)
    expect(mocks.loadHooks).toHaveBeenCalledWith(WSL_REPO)
  })

  it("gates the runtime read a paired client's Settings pane makes, and passes a launch's wake", async () => {
    const reader = new RuntimeRepositoryIssueCommand({
      resolveRepo: async () => ({
        id: 'repo-1',
        path: WSL_REPO,
        displayName: 'repo',
        badgeColor: '#000',
        addedAt: 1,
        kind: 'git'
      }),
      getLocalGitArgs: () => []
    })
    await expect(reader.read('id:repo-1')).resolves.toMatchObject({ status: 'error' })
    expect(mocks.loadHooks).not.toHaveBeenCalled()
    await reader.read('id:repo-1', { wakeWslDistro: true })
    expect(mocks.loadHooks).toHaveBeenCalledWith(WSL_REPO)
  })
})
