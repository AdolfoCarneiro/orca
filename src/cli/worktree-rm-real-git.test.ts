import '../main/runtime/rpc/unused-default-rpc-methods.test-fixture'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { RuntimeWorkspaceSelectors } from '../main/runtime/workspaces/workspace-selectors'
import { resolveRuntimeWorktreeRemovalTarget } from '../main/runtime/runtime-worktree-removal-target'
import { getExplicitWorktreeIdSelector } from '../main/runtime/runtime-worktree-selection'
import { mergeRuntimeFolderWorkspace } from '../main/runtime/runtime-folder-workspace'
import type { ResolvedWorktree } from '../main/runtime/runtime-worktree-path-identity'
import { WorktreeRemove } from '../shared/rpc-contract/worktree-params'
import { UnixSocketTransport } from '../main/runtime/rpc/unix-socket-transport'
import { getRuntimeMetadataPath } from '../shared/runtime-bootstrap'
import { RuntimeClient } from './runtime/client'
import type { Repo } from '../shared/repo-types'
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

// Keep app construction and unrelated project creation outside this CLI/Git boundary test.
vi.mock('../main/runtime/workspaces/workspace-metadata', () => ({
  OrcaRuntimeWithCreateManagedRemoteWorktree: class {}
}))
vi.mock('../main/ipc/worktree-remote', () => ({
  cleanupUnusedWorktreePushTargetRemote: async () => {}
}))

import { main } from './index'
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
let socket: UnixSocketTransport
let client: RuntimeClient
let repo: Repo
let folderRepo: Repo
let rows: ResolvedWorktree[]
let afterShow = () => {}
const stopped = vi.fn(async () => {})
const removedMetadata = vi.fn()
const received = vi.fn()
let beforeStatus = async () => {}
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
  repo = { id: 'repo', path: repoPath, displayName: 'repo', addedAt: 1, badgeColor: '' }
  beforeStatus = async () => {}
  received.mockClear()
  removedMetadata.mockClear()
  vi.stubEnv('ORCA_USER_DATA_PATH', directory)
  vi.stubEnv('ORCA_PAIRING_CODE', '')
  vi.stubEnv('ORCA_REMOTE_PAIRING', '')
  vi.stubEnv('ORCA_ENVIRONMENT', '')
  folderRepo = { ...repo, id: 'folder', path: directory, kind: 'folder' }
  rows = [
    {
      ...mergeRuntimeFolderWorkspace(repo, id, {}),
      path: checkout,
      branch: 'task',
      parentWorktreeId: null,
      childWorktreeIds: [],
      lineage: null,
      git: { path: checkout, branch: 'task', head: '', isBare: false, isMainWorktree: false }
    }
  ]
  afterShow = () => {}
  stopped.mockClear()
  const store = {
    getRepos: () => [repo, folderRepo],
    getRepo: (repoId: string) => (repoId === repo.id ? repo : folderRepo),
    getWorktreeMeta: () => ({ preserveBranchOnDelete }),
    getProjectRuntime: () => undefined
  }
  const match = (selector: string): ResolvedWorktree =>
    Reflect.apply(
      Reflect.get(RuntimeWorkspaceSelectors.prototype, 'matchWorktreeSelector'),
      { store, getValidatedExplicitWorktreeIdSelector: getExplicitWorktreeIdSelector },
      [selector, rows]
    )
  const runtime = {
    store,
    workspaceLifecycle: new WorkspaceLifecycleQueue(),
    removeManagedWorktreeInFlight: new RuntimeWorktreeRemovalInFlight(),
    getRuntimeId: () => 'rm-runtime',
    listRepos: store.getRepos,
    showManagedWorktree: async (selector: string) => {
      const target = match(selector)
      const result = {
        ...target,
        hostId: replyHostId,
        workspaceKind: store.getRepo(target.repoId).kind === 'folder' ? 'folder-workspace' : 'git'
      }
      afterShow()
      return result
    },
    getLocalProvider: () => null,
    removeWorktreeMetadataAndHistory: removedMetadata,
    invalidateResolvedWorktreeCache: () => {},
    notifyWorktreesChanged: () => {},
    listTerminals: async () => ({ totalCount: 0 }),
    requireStore: () => store,
    resolveWorktreeRemovalTarget: (selector: string, hostId?: 'local') =>
      resolveRuntimeWorktreeRemovalTarget({
        selector,
        store: null,
        resolveWorktree: async (value) => match(value),
        resolveExplicitWorktreeIdScoped: async (value, host) =>
          host === 'local' ? (rows.find((row) => row.id === value) ?? null) : null,
        requiredHostId: hostId
      }),
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
    stopPtysForDestructiveWorktreeRemoval: stopped,
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
  const kind = process.platform === 'win32' ? 'named-pipe' : 'unix'
  const endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\orca-rm-${process.pid}`
      : join(directory, 'rpc.sock')
  socket = new UnixSocketTransport({ kind, endpoint })
  socket.onMessage((message, reply) => {
    const request = JSON.parse(message)
    received(request.method, request.params)
    void (async () => {
      if (request.method === 'status.get') {
        await beforeStatus()
        reply(
          JSON.stringify({
            id: request.id,
            ok: true,
            result: { capabilities: supported ? [capability] : [] },
            _meta: { runtimeId: 'rm-runtime' }
          })
        )
      } else {
        reply(JSON.stringify(await dispatcher.dispatch(request)))
      }
    })()
  })
  await socket.start()
  await writeFile(
    getRuntimeMetadataPath(directory),
    JSON.stringify({
      runtimeId: 'rm-runtime',
      pid: process.pid,
      transports: [{ kind, endpoint }],
      authToken: 'test',
      startedAt: 1
    })
  )
  client = new RuntimeClient(directory, 5000, null, null)
})

afterEach(async () => {
  await _settlePendingWorktreeRemovalsForTests()
  _resetPendingWorktreeRemovalsForTests()
  await socket?.stop()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  process.exitCode = undefined
  await removeTree(directory)
})

it.each([
  { flags: [], deleted: false, host: 'runtime:server' },
  { flags: ['--force'], deleted: false },
  { flags: ['--delete-branch'], deleted: true }
])(
  'runs CLI $flags on $host through RPC/lifecycle/background Git, deleted=$deleted',
  async ({ flags, deleted, host }) => {
    replyHostId = host ?? 'local'
    // Existing branches have preservation metadata; explicit opt-in must override it.
    preserveBranchOnDelete = flags.includes('--delete-branch')
    const head = await git('rev-parse', 'task')
    await main(['worktree', 'rm', '--worktree', `id:${id}`, ...flags, '--json'], repoPath)
    expect(process.exitCode).not.toBe(1)
    await _settlePendingWorktreeRemovalsForTests()
    expect(existsSync(checkout)).toBe(false)
    expect(await git('for-each-ref', '--format=%(refname:short)', 'refs/heads/task')).toBe(
      deleted ? '' : 'task'
    )
    if (!deleted) {
      expect(await git('rev-parse', 'task')).toBe(head)
    }
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
    expect(received.mock.calls.some(([method]) => method === 'worktree.rm')).toBe(false)
  }
)

it.each([false, true])('preserves legacy omitted-field metadata policy %s', async (preserve) => {
  preserveBranchOnDelete = preserve
  await client.call('worktree.rm', { worktree: `id:${id}`, waitForBackgroundRemoval: true })
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
    const run = vi.fn(() => gitPending.promise)
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
        run,
        publish: () => {}
      })
      const record = pendingWorktreeRemovals.get(id)
      const joined = waitForPendingWorktreeRemoval(id, 'local', deleteBranch)
      expect(waitForPendingWorktreeRemoval(id, 'local')).toBe(joined)
      expect(joined).toBeDefined()
      block.resolve()
      await first
      await new Promise((resolve) => setImmediate(resolve))
      expect(pendingWorktreeRemovals.get(id)).toBe(record)
      expect(record?.deleteBranch).toBe(deleteBranch)
      expect(existsSync(checkout)).toBe(true)
      expect(await git('for-each-ref', '--format=%(refname:short)', 'refs/heads/task')).toBe('task')
      gitPending.resolve({})
      await refused
      await expect(joined).resolves.toEqual({})
      expect(run).toHaveBeenCalledOnce()
    } finally {
      block.resolve()
      gitPending.resolve({})
      await first
    }
  }
)

it.each([false, true])('keeps folder directory on incapable host, root=%s', async (root) => {
  repo.kind = 'folder'
  supported = false
  id = root
    ? `repo::${repoPath}`
    : `repo::${repoPath}::workspace:00000000-0000-4000-8000-000000000001`
  rows = [{ ...rows[0], id, path: repoPath }]
  await main(['worktree', 'rm', '--worktree', `id:${id}`, '--json'], repoPath)
  expect(process.exitCode === 1).toBe(root)
  expect(removedMetadata).toHaveBeenCalledTimes(root ? 0 : 1)
  expect(existsSync(repoPath)).toBe(true)
  expect(received.mock.calls.map(([method]) => method)).toEqual(['worktree.show', 'worktree.rm'])
  expect(received.mock.calls.at(-1)?.[1]).not.toHaveProperty('deleteBranch')
  const output = String(vi.mocked(console.log).mock.calls.at(-1)?.[0])
  expect(output).not.toContain('branch')
  if (root) {
    expect(output).toContain('root workspace')
  }
})

it('keeps the verified receiver when discovery switches to a live legacy receiver', async () => {
  const kind = process.platform === 'win32' ? 'named-pipe' : 'unix'
  const endpoint =
    process.platform === 'win32'
      ? String.raw`\\.\pipe\orca-rm-${process.pid}-legacy`
      : join(directory, 'old.sock')
  const legacy = new UnixSocketTransport({ kind, endpoint })
  const methods: string[] = []
  legacy.onMessage((message, reply) => {
    const request = JSON.parse(message)
    methods.push(request.method)
    if (request.method === 'worktree.rm') {
      request.params = WorktreeRemove.omit({ deleteBranch: true }).parse(request.params)
    }
    void dispatcher.dispatch(request).then((result) => reply(JSON.stringify(result)))
  })
  try {
    await legacy.start()
    beforeStatus = () =>
      writeFile(
        getRuntimeMetadataPath(directory),
        JSON.stringify({
          runtimeId: 'rm-runtime',
          pid: process.pid,
          transports: [{ kind, endpoint }],
          authToken: 'test',
          startedAt: 2
        })
      )
    const head = await git('rev-parse', 'task')
    await main(['worktree', 'rm', '--worktree', `id:${id}`, '--json'], repoPath)
    expect(process.exitCode).not.toBe(1)
    expect(existsSync(checkout)).toBe(false)
    expect(await git('rev-parse', 'task')).toBe(head)
    expect(methods).toEqual([])
    expect(received.mock.calls.map(([method]) => method)).toEqual([
      'worktree.show',
      'status.get',
      'worktree.rm'
    ])
  } finally {
    await legacy.stop()
  }
})

it('does not dispatch after its preflight receiver disconnects', async () => {
  beforeStatus = () => socket.stop()
  await main(['worktree', 'rm', '--worktree', `id:${id}`, '--json'], repoPath)
  expect(process.exitCode).toBe(1)
  expect(received.mock.calls.map(([method]) => method)).toEqual(['worktree.show', 'status.get'])
  expect(existsSync(checkout)).toBe(true)
  expect(await git('rev-parse', 'task')).not.toBe('')
})

it.each([false, true])(
  'pins a renamed folder instance and never falls back to Git when missing=%s',
  async (missing) => {
    const gitRow = rows[0]
    gitRow.displayName = 'other'
    const folderId = `folder::${directory}::workspace:00000000-0000-4000-8000-000000000001`
    const folder = {
      ...mergeRuntimeFolderWorkspace(folderRepo, folderId, { displayName: 'target' }),
      parentWorktreeId: null,
      childWorktreeIds: [],
      lineage: null,
      git: { path: directory, branch: '', head: '', isBare: false, isMainWorktree: false }
    }
    rows.push(folder)
    afterShow = () => {
      afterShow = () => {}
      folder.displayName = 'renamed'
      gitRow.displayName = 'target'
      if (missing) {
        rows = [gitRow]
      }
    }
    const head = await git('rev-parse', 'task')
    await main(['worktree', 'rm', '--worktree', 'name:target', '--json'], repoPath)
    expect(process.exitCode === 1).toBe(missing)
    expect(received.mock.calls.at(-1)).toEqual([
      'worktree.rm',
      expect.objectContaining({ worktree: `id:${folderId}`, hostId: 'local' })
    ])
    expect(received.mock.calls.at(-1)?.[1]).not.toHaveProperty('deleteBranch')
    expect(removedMetadata).toHaveBeenCalledTimes(missing ? 0 : 1)
    if (!missing) {
      expect(removedMetadata.mock.calls[0]?.[1]).toBe(folderId)
    }
    expect(existsSync(checkout)).toBe(true)
    expect(existsSync(directory)).toBe(true)
    expect(await git('rev-parse', 'task')).toBe(head)
  }
)

it('settles the same dirty-checkout refusal for omitted and explicit keep intent', async () => {
  await writeFile(join(checkout, 'file'), 'unsaved')
  const head = await git('rev-parse', 'task')
  const registered = await git('worktree', 'list', '--porcelain')
  const failures: string[] = []
  for (const deleteBranch of [undefined, false]) {
    const failure = await client
      .call('worktree.rm', {
        worktree: `id:${id}`,
        hostId: 'local',
        force: false,
        runHooks: false,
        allowUnverifiedPtyStop: false,
        allowFailedArchiveHook: false,
        ...(deleteBranch === undefined ? {} : { deleteBranch }),
        waitForBackgroundRemoval: true
      })
      .then(
        () => {
          throw new Error('Expected dirty refusal')
        },
        (error: unknown) => String(error)
      )
    failures.push(failure)
    expect(await readFile(join(checkout, 'file'), 'utf8')).toBe('unsaved')
    expect(await git('rev-parse', 'task')).toBe(head)
    expect(await git('worktree', 'list', '--porcelain')).toBe(registered)
    expect(pendingWorktreeRemovals.size).toBe(0)
  }
  expect(failures[0]).toContain('M file')
  expect(failures[1]).toBe(failures[0])
  expect(stopped).not.toHaveBeenCalled()
})
