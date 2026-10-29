import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const {
  callMock,
  runtimeClientConstructorMock,
  serveOrcaAppMock,
  getDefaultUserDataPathMock,
  addEnvironmentFromPairingCodeMock,
  listEnvironmentsMock,
  spawnMock
} = vi.hoisted(() => ({
  callMock: vi.fn(),
  runtimeClientConstructorMock: vi.fn(),
  serveOrcaAppMock: vi.fn(),
  getDefaultUserDataPathMock: vi.fn(() => '/tmp/orca-user-data'),
  addEnvironmentFromPairingCodeMock: vi.fn(),
  listEnvironmentsMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('./runtime-client', async () => {
  const { createRuntimeClientModuleMock } = await import('./index-test-harness.js')
  return createRuntimeClientModuleMock({
    callMock,
    runtimeClientConstructorMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock
  })
})

vi.mock('./runtime/environments', () => ({
  addEnvironmentFromPairingCode: addEnvironmentFromPairingCodeMock,
  listEnvironments: listEnvironmentsMock,
  removeEnvironment: vi.fn(),
  resolveEnvironment: vi.fn()
}))

vi.mock('child_process', async () => {
  const { createChildProcessModuleMock } = await import('./index-test-harness.js')
  return createChildProcessModuleMock(spawnMock)
})

import { main } from './index'
import { buildWorktree, okFixture, queueFixtures, worktreeListFixture } from './test-fixtures'
import { useWorktreeAwarenessEnvironment } from './index-test-harness'

const SSH_CALLER = {
  ORCA_ORCHESTRATION_COMPATIBILITY_HOST_KIND: 'ssh',
  ORCA_ORCHESTRATION_COMPATIBILITY_HOST_ID: 'box-b',
  ORCA_ORCHESTRATION_COMPATIBILITY_HOST_INCARNATION: 'inc-1',
  ORCA_ORCHESTRATION_COMPATIBILITY_ATTACHMENT: 'att-1'
}

describe('worktree create from a worktree another host shares an id with', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  afterEach(() => {
    for (const key of Object.keys(SSH_CALLER)) {
      delete process.env[key]
    }
  })

  it('infers the repo while the parent stays the exact host-scoped identity', async () => {
    Object.assign(process.env, SSH_CALLER)
    queueFixtures(
      callMock,
      worktreeListFixture([
        {
          ...buildWorktree('/srv/app', 'main', 'abc', 'repo-1'),
          hostId: 'ssh:box-a',
          identity: { key: 'wt2:a' }
        },
        {
          ...buildWorktree('/srv/app', 'main', 'abc', 'repo-1'),
          hostId: 'ssh:box-b',
          identity: { key: 'wt2:b' }
        }
      ]),
      okFixture('req_create', {
        worktree: buildWorktree('/srv/app-child', 'child', 'abc', 'repo-1'),
        lineage: null,
        warnings: []
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['worktree', 'create', '--name', 'child', '--json'], '/srv/app/src')

    expect(callMock).toHaveBeenNthCalledWith(
      2,
      'worktree.create',
      expect.objectContaining({ repo: 'id:repo-1', cwdParentWorktree: 'identity:wt2:b' })
    )
  })

  it('infers checkout ownership independently of workspace identity and catalog order', async () => {
    const path = resolve('/tmp/sta-12478')
    const root = buildWorktree(path, 'main', 'abc', 'repo-a')
    const other = buildWorktree(path, 'main', 'abc', 'repo-b')
    const sibling = { ...root, id: `${root.id}::workspace:11111111-1111-4111-8111-111111111111` }
    const folder = { ...root, id: 'folder:f1', repoId: 'folder-workspace:group-1' }
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode
    const cases = [
      { rows: [root, other], caller: undefined, repo: undefined },
      { rows: [root, other], caller: other.id, repo: 'repo-b' },
      { rows: [root, other], caller: 'missing::workspace', repo: undefined },
      { rows: [root, root], caller: undefined, repo: 'repo-a' },
      { rows: [root, sibling], caller: undefined, repo: 'repo-a' },
      { rows: [root, folder], caller: undefined, repo: undefined },
      { rows: [root, folder], caller: root.id, repo: 'repo-a' },
      { rows: [root, { ...root, hostId: 'runtime:other' }], caller: undefined, repo: undefined }
    ]
    try {
      for (const testCase of cases) {
        for (const rows of [testCase.rows, [...testCase.rows].reverse()]) {
          callMock.mockReset()
          logSpy.mockClear()
          errSpy.mockClear()
          process.exitCode = priorExitCode
          if (testCase.caller) process.env.ORCA_WORKTREE_ID = testCase.caller
          else delete process.env.ORCA_WORKTREE_ID
          queueFixtures(
            callMock,
            worktreeListFixture(rows),
            okFixture('create', {
              worktree: buildWorktree(join(path, 'child'), 'child'),
              lineage: null,
              warnings: []
            })
          )
          await main(['worktree', 'create', '--name', 'child', '--no-parent', '--json'], path)
          if (testCase.repo) {
            expect(process.exitCode).toBe(priorExitCode)
            expect(callMock).toHaveBeenCalledWith(
              'worktree.create',
              expect.objectContaining({
                repo: `id:${testCase.repo}`,
                noParent: true
              })
            )
          } else {
            expect(callMock).not.toHaveBeenCalledWith('worktree.create', expect.anything())
            expect(process.exitCode).toBe(1)
            const printed = [...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')
            expect(printed).toContain('selector_ambiguous')
            expect(printed).toContain('Choose the project with --repo or --project')
          }
        }
      }
      // An explicit target keeps optional-parent and active/current workspace behavior.
      delete process.env.ORCA_WORKTREE_ID
      for (const parent of [undefined, 'active', 'current']) {
        callMock.mockReset()
        process.exitCode = priorExitCode
        callMock.mockImplementation(async (method: string) => {
          if (method === 'worktree.list') return worktreeListFixture([root, other])
          return okFixture('create', {
            worktree: buildWorktree(join(path, 'child'), 'child'),
            lineage: null,
            warnings: []
          })
        })
        await main(
          [
            'worktree',
            'create',
            '--name',
            'child',
            '--repo',
            'id:repo-b',
            ...(parent ? ['--parent-worktree', parent] : []),
            '--json'
          ],
          path
        )
        expect(process.exitCode).toBe(priorExitCode)
        expect(callMock).toHaveBeenCalledWith(
          'worktree.create',
          expect.objectContaining({
            repo: 'id:repo-b',
            ...(parent
              ? { parentWorktree: `id:${root.id}` }
              : { cwdParentWorktree: `id:${root.id}` })
          })
        )
      }
      // A unique project does not elect a different implicit lineage parent.
      callMock.mockReset()
      queueFixtures(
        callMock,
        worktreeListFixture([sibling, root]),
        okFixture('create', {
          worktree: buildWorktree(join(path, 'child'), 'child'),
          lineage: null,
          warnings: []
        })
      )
      await main(['worktree', 'create', '--name', 'child', '--json'], path)
      expect(callMock).toHaveBeenCalledWith(
        'worktree.create',
        expect.objectContaining({
          repo: 'id:repo-a',
          cwdParentWorktree: `id:${sibling.id}`
        })
      )
    } finally {
      process.exitCode = priorExitCode
    }
  })
})
