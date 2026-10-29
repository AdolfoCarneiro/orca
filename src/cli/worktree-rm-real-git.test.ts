import '../main/runtime/rpc/unused-default-rpc-methods.test-fixture'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../main/runtime/orca-runtime'
import type { RemoveManagedWorktreeOptions } from '../main/runtime/runtime-worktree-selection'
import type { GitWorktreeInfo } from '../shared/worktree/types'
import { retryFailedRemovalUnlessRegistered } from '../main/worktree-removal-leftover'
import type { RemoveWorktreeResult } from '../shared/worktree/create-types'

const transport = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('./runtime-client', async () => ({
  ...(await import('./runtime/types')),
  RuntimeClient: class {
    call = transport.call
  }
}))
// Keep app construction and unrelated project creation outside this CLI/Git boundary test.
vi.mock('../main/runtime/workspaces/workspace-metadata', () => ({
  OrcaRuntimeWithCreateManagedRemoteWorktree: class {}
}))
vi.mock('../main/ipc/worktree-remote', () => ({
  cleanupUnusedWorktreePushTargetRemote: async () => {}
}))

import { main } from './index'
import { RuntimeRpcFailureError } from './runtime/types'
import { RpcDispatcher } from '../main/runtime/rpc/dispatcher'
import { WORKTREE_METHODS } from '../main/runtime/rpc/methods/worktree'
import { OrcaRuntimeWithRemoveManagedWorktree } from '../main/runtime/workspaces/workspace-removal'
import { WorkspaceLifecycleQueue } from '../main/runtime/workspaces/workspace-lifecycle-queue'
import { RuntimeWorktreeRemovalInFlight } from '../main/runtime/runtime-worktree-removal-in-flight'
import { installRealWorkerThreadChildProcesses } from '../main/worker-thread-child-process/worker-thread-child-process-real.test-fixtures'
import { removeTree } from '../shared/windows-transient-lock-removal'
import {
  _resetPendingWorktreeRemovalsForTests,
  _settlePendingWorktreeRemovalsForTests,
  startBackgroundWorktreeRemoval,
  waitForPendingWorktreeRemoval
} from '../main/worktree-background-removal'
import * as acceptance from '../main/worktree-removal-acceptance-queue'
import { failedWorktreeRemovals, pendingWorktreeRemovals } from '../main/worktree-removal-table'

installRealWorkerThreadChildProcesses()
const exec = promisify(execFile)
const capability = 'worktree.remove-branch-policy.v1'
let directory = ''
let repoPath = ''
let checkout = ''
let id = ''
let dispatcher: RpcDispatcher
let removeManaged: (
  selector: string,
  options: RemoveManagedWorktreeOptions
) => Promise<RemoveWorktreeResult>
let preserveBranchOnDelete = false
let supported = true
let replyHostId = 'local'
const git = async (...args: string[]) => (await exec('git', args, { cwd: repoPath })).stdout.trim()

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  directory = await realpath(await mkdtemp(join(tmpdir(), 'orca-cli-rm-')))
  repoPath = join(directory, 'repo')
  checkout = join(directory, 'checkout')
  id = `repo::${checkout}`
  preserveBranchOnDelete = false
  supported = true
  replyHostId = 'local'
  await mkdir(repoPath)
  await git('init', '-q')
  await git('checkout', '-qb', 'main')
  await git('config', 'user.email', 'rm@example.invalid')
  await git('config', 'user.name', 'CLI Removal')
  await git('config', 'maintenance.auto', 'false')
  await git('config', 'gc.auto', '0')
  await writeFile(join(repoPath, 'file'), 'seed')
  await git('add', '.')
  await git('commit', '-qm', 'seed')
  await git('worktree', 'add', '-qb', 'task', checkout)
  await writeFile(join(checkout, 'file'), 'task change')
  await git('-C', checkout, 'commit', '-qam', 'task')
  await git('merge', '--squash', 'task')
  await git('commit', '-qm', 'squashed task')
  const repo = { id: 'repo', path: repoPath, displayName: 'repo', addedAt: 1, badgeColor: '' }
  const store = {
    getRepos: () => [repo],
    getRepo: () => repo,
    getWorktreeMeta: () => ({ preserveBranchOnDelete }),
    getProjectRuntime: () => undefined
  }
  const target = { id, repoId: 'repo', path: checkout }
  const runtime = {
    store,
    workspaceLifecycle: new WorkspaceLifecycleQueue(),
    removeManagedWorktreeInFlight: new RuntimeWorktreeRemovalInFlight(),
    getRuntimeId: () => 'rm-runtime',
    listRepos: store.getRepos,
    showManagedWorktree: async () => ({ ...target, hostId: replyHostId }),
    listTerminals: async () => ({ totalCount: 0 }),
    requireStore: () => store,
    resolveWorktreeRemovalTarget: async () => target,
    joinPendingWorktreeRemoval(worktreeId: string, options: RemoveManagedWorktreeOptions) {
      return waitForPendingWorktreeRemoval(worktreeId, 'local', options.deleteBranch)
    },
    retryFailedRemoval: async (
      _route: unknown,
      target: { id: string; path: string },
      registered: GitWorktreeInfo[]
    ) =>
      retryFailedRemovalUnlessRegistered(target.id, target.path, registered, {}, () => undefined),
    removeManagedWorktree(selector: string, options: RemoveManagedWorktreeOptions) {
      return Reflect.apply(
        OrcaRuntimeWithRemoveManagedWorktree.prototype.removeManagedWorktree,
        runtime,
        [selector, options]
      )
    },
    acquireFileWatcherRemoval: async () => ({ finish: async () => {} }),
    stopPtysForDestructiveWorktreeRemoval: async () => {},
    closeFileWatchersForRemoval: async () => {},
    purgeRemovedWorktree: () => {},
    emitWorktreeLifecycle: () => {},
    publishWorktreeRemovalChange: () => {},
    preservedBranchCleanup: {
      delete: () => {},
      remember: () => {},
      preserveHead: (result: RemoveWorktreeResult) => result
    }
  }
  removeManaged = runtime.removeManagedWorktree
  dispatcher = new RpcDispatcher({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture supplies every method reached by worktree.show/rm.
    runtime: runtime as unknown as OrcaRuntimeService,
    methods: WORKTREE_METHODS
  })
  transport.call.mockReset().mockImplementation(async (method: string, params?: unknown) => {
    if (method === 'status.get') {
      return { ok: true, result: { capabilities: supported ? [capability] : [] } }
    }
    const reply = await dispatcher.dispatch({ id: 'rm', authToken: 'test', method, params })
    if (!reply.ok) {
      throw new RuntimeRpcFailureError(reply)
    }
    return reply
  })
})

afterEach(async () => {
  await _settlePendingWorktreeRemovalsForTests()
  _resetPendingWorktreeRemovalsForTests()
  vi.restoreAllMocks()
  process.exitCode = undefined
  await removeTree(directory)
})

it.each([
  { flags: [], deleted: false, host: 'local' },
  { flags: [], deleted: false, host: 'runtime:server' },
  { flags: ['--force'], deleted: false },
  { flags: ['--delete-branch'], deleted: true }
])(
  'runs CLI $flags on $host through RPC/lifecycle/background Git, deleted=$deleted',
  async ({ flags, deleted, host }) => {
    replyHostId = host ?? 'local'
    // Existing branches have preservation metadata; explicit opt-in must override it.
    preserveBranchOnDelete = flags.includes('--delete-branch')
    await main(['worktree', 'rm', '--worktree', `id:${id}`, ...flags, '--json'], repoPath)
    expect(process.exitCode).not.toBe(1)
    await _settlePendingWorktreeRemovalsForTests()
    expect(existsSync(checkout)).toBe(false)
    expect(await git('for-each-ref', '--format=%(refname:short)', 'refs/heads/task')).toBe(
      deleted ? '' : 'task'
    )
  }
)

it.each([{ flags: [] }, { flags: ['--delete-branch'] }])(
  'refuses unsupported branch choice $flags before mutation',
  async ({ flags }) => {
    supported = false
    preserveBranchOnDelete = true
    await main(['worktree', 'rm', '--worktree', `id:${id}`, ...flags, '--json'], repoPath)
    expect(process.exitCode).toBe(1)
    expect(JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0]))).toMatchObject({
      error: { code: 'incompatible_runtime' }
    })
    expect(existsSync(checkout)).toBe(true)
    expect(await git('for-each-ref', '--format=%(refname:short)', 'refs/heads/task')).toBe('task')
    expect(transport.call.mock.calls.some(([method]) => method === 'worktree.rm')).toBe(false)
  }
)

it.each([false, true])('preserves legacy omitted-field metadata policy %s', async (preserve) => {
  preserveBranchOnDelete = preserve
  await transport.call('worktree.rm', { worktree: `id:${id}`, waitForBackgroundRemoval: true })
  expect(existsSync(checkout)).toBe(false)
  expect(await git('for-each-ref', '--format=%(refname:short)', 'refs/heads/task')).toBe(
    preserve ? 'task' : ''
  )
})

it('does not apply a failed record’s branch choice to a freshly registered checkout', async () => {
  failedWorktreeRemovals.set(id, {
    worktreeId: id,
    repoId: 'repo',
    repoPath,
    worktreePath: checkout,
    branch: 'old-task',
    head: '',
    deleteBranch: true,
    force: false,
    requestedAt: 1,
    failure: { message: 'old failure', failedAt: 2 }
  })
  await main(['worktree', 'rm', '--worktree', `id:${id}`, '--json'], repoPath)
  expect(process.exitCode).not.toBe(1)
  expect(existsSync(checkout)).toBe(false)
  expect(await git('for-each-ref', '--format=%(refname:short)', 'refs/heads/task')).toBe('task')
})

it.each([false, true])(
  'rechecks branch intent after acceptance-queue wait, accepted=%s',
  async (deleteBranch) => {
    const block = Promise.withResolvers<void>()
    const gitPending = Promise.withResolvers<RemoveWorktreeResult>()
    const first = acceptance.runSerializedWorktreeRemovalAcceptance(repoPath, () => block.promise)
    const entering = vi.spyOn(acceptance, 'runSerializedWorktreeRemovalAcceptance')
    const request = removeManaged(`id:${id}`, {
      deleteBranch: !deleteBranch,
      waitForBackgroundRemoval: true
    })
    // Observe rejection immediately so the forced schedule cannot create an unhandled rejection.
    const refused = expect(request).rejects.toThrow('different branch choice')
    try {
      await vi.waitFor(() => expect(entering).toHaveBeenCalledOnce())
      void startBackgroundWorktreeRemoval({
        removal: {
          worktreeId: id,
          repoId: 'repo',
          repoPath,
          worktree: { path: checkout, branch: 'task', head: '' },
          deleteBranch,
          force: false
        },
        run: () => gitPending.promise,
        publish: () => {}
      })
      const record = pendingWorktreeRemovals.get(id)
      block.resolve()
      await first
      await new Promise((resolve) => setImmediate(resolve))
      expect(pendingWorktreeRemovals.get(id)).toBe(record)
      expect(record?.deleteBranch).toBe(deleteBranch)
      expect(existsSync(checkout)).toBe(true)
      expect(await git('for-each-ref', '--format=%(refname:short)', 'refs/heads/task')).toBe('task')
      gitPending.resolve({})
      await refused
    } finally {
      block.resolve()
      gitPending.resolve({})
      await first
    }
  }
)
