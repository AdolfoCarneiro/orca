import { runProcess } from '@orca/process-host'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { GitWorktreeInfo } from '../shared/worktree/types'
import * as localFilesystem from './local-worktree-filesystem'
import * as removalRoute from './worktree-removal-execution-host-route'
import { CLIENT_REMOVAL_HOME, executionHostRemovalHome } from './worktree-removal-home-guard'
import {
  canSafelyRemoveOrphanedWorktreeDirectory,
  ORPHANED_WORKTREE_DIRECTORY_MESSAGE
} from './worktree-removal-safety'
import { removeRuntimeUnregisteredWorktree } from './runtime/runtime-unregistered-worktree-removal'
import {
  partialRuntimeStore,
  storeRepo,
  storeWorktreeMeta
} from './runtime/runtime-store-partial-fixture'
import { removeWorktree } from './git/worktree-removal'
import { cleanupUnusedWorktreePushTargetRemote } from './ipc/worktree-remote'

vi.mock('./git/worktree-removal', () => ({
  removeWorktree: vi.fn(async () => {
    throw new Error('Unexpected Git deletion')
  })
}))
vi.mock('./ipc/worktree-remote', () => ({
  cleanupUnusedWorktreePushTargetRemote: vi.fn(async () => {
    throw new Error('Unexpected remote cleanup')
  })
}))

let root = ''
const layouts = [
  { owner: 'main', name: 'ordinary' },
  { owner: 'linked', name: 'ordinary' },
  ...(process.platform === 'win32'
    ? []
    : [
        { owner: 'main', name: 'line\nbreak' },
        { owner: 'linked', name: 'line\nbreak' }
      ])
]

type Checkout = Awaited<ReturnType<typeof createCheckout>>

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'orca-orphan-gitfile-')))
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
  vi.stubEnv('GIT_CONFIG_GLOBAL', join(root, 'missing-config'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

async function gitResult(cwd: string, ...args: string[]) {
  const result = await runProcess({
    program: 'git',
    args,
    cwd,
    env: process.env,
    timeoutMs: 10_000
  })
  expect(result.timedOut).toBe(false)
  return result
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await gitResult(cwd, ...args)
  expect(result.code, result.stderr).toBe(0)
  return result.stdout
}

async function createCheckout(owner = 'main', name = 'ordinary', candidateName = 'candidate') {
  const main = join(root, owner === 'main' ? name : 'main')
  const path = join(root, candidateName)
  await mkdir(main)
  await git(main, 'init', '-q')
  await writeFile(join(main, 'preserved.txt'), 'preserved checkout bytes\n')
  await git(main, 'add', '.')
  await git(
    main,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.test',
    '-c',
    'core.hooksPath=',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'base'
  )
  let repoPath = main
  const head = (await git(main, 'rev-parse', 'HEAD')).trim()
  const branch = (await git(main, 'symbolic-ref', 'HEAD')).trim()
  const registered: GitWorktreeInfo[] = [
    { path: main, head, branch, isMainWorktree: true, isBare: false }
  ]
  if (owner === 'linked') {
    repoPath = join(root, name)
    await git(main, 'worktree', 'add', '-qb', 'owner', repoPath)
    registered.push({
      path: repoPath,
      head,
      branch: 'refs/heads/owner',
      isMainWorktree: false,
      isBare: false
    })
  }
  await git(main, 'worktree', 'add', '-qb', 'candidate', path)
  const admin = resolve((await git(path, 'rev-parse', '--absolute-git-dir')).replace(/\r?\n$/, ''))
  expect(resolve((await git(path, 'rev-parse', '--show-toplevel')).replace(/\r?\n$/, ''))).toBe(
    path
  )
  return { main, path, admin, registered, repo: storeRepo({ id: 'repo', path: repoPath }) }
}

async function orphan(checkout: Checkout): Promise<void> {
  await rm(checkout.admin, { recursive: true, force: true })
  expect(await git(checkout.main, 'worktree', 'list', '--porcelain')).not.toContain(checkout.path)
}

async function expectRuntimeOutcome(checkout: Checkout, message: string): Promise<void> {
  const marker = await readFile(join(checkout.path, '.git'))
  const contents = await readFile(join(checkout.path, 'preserved.txt'))
  const acquireWatcherRemoval = vi.fn(async () => {
    throw new Error('Unexpected watcher teardown')
  })
  const stopPtys = vi.fn(async () => {
    throw new Error('Unexpected PTY teardown')
  })
  const finishRemoval = vi.fn()
  await expect(
    removeRuntimeUnregisteredWorktree({
      repo: checkout.repo,
      target: { id: `repo::${checkout.path}`, repoId: 'repo', path: checkout.path },
      registeredWorktrees: checkout.registered,
      removedMeta: storeWorktreeMeta({ orcaCreatedAt: 1, orcaCreationSource: 'runtime' }),
      removedPushTarget: undefined,
      force: false,
      allowUnverifiedPtyStop: false,
      route: { kind: 'local', hostId: 'local' },
      localOptions: {},
      store: partialRuntimeStore(),
      acquireWatcherRemoval,
      stopPtys,
      finishRemoval
    })
  ).rejects.toThrow(message)
  for (const callback of [
    acquireWatcherRemoval,
    stopPtys,
    finishRemoval,
    removeWorktree,
    cleanupUnusedWorktreePushTargetRemote
  ]) {
    expect(callback).not.toHaveBeenCalled()
  }
  expect(await readFile(join(checkout.path, '.git'))).toEqual(marker)
  expect(await readFile(join(checkout.path, 'preserved.txt'))).toEqual(contents)
}

it.each(layouts)(
  'requires force for an actual orphan from $owner owner %j',
  async ({ owner, name }) => {
    const checkout = await createCheckout(owner, name)
    await orphan(checkout)
    await expectRuntimeOutcome(checkout, ORPHANED_WORKTREE_DIRECTORY_MESSAGE)
  }
)

it.each(['GITDIR: ', 'gitdir:'])('refuses Git-invalid marker prefix %j', async (prefix) => {
  const checkout = await createCheckout()
  const marker = join(checkout.path, '.git')
  await writeFile(marker, (await readFile(marker, 'utf8')).replace(/^gitdir: /, prefix))
  expect((await gitResult(checkout.path, 'rev-parse', '--show-toplevel')).code).toBe(128)
  await orphan(checkout)
  await expect(
    canSafelyRemoveOrphanedWorktreeDirectory(checkout.path, checkout.repo.path, CLIENT_REMOVAL_HOME)
  ).resolves.toBe(false)
  if (process.platform !== 'win32') {
    await expectRuntimeOutcome(
      checkout,
      `Refusing to delete unregistered worktree path: ${checkout.path}`
    )
  }
})

it.skipIf(process.platform === 'win32')(
  'keeps a copied foreign marker outside orphan admission',
  async () => {
    const checkout = await createCheckout()
    const foreign = join(root, 'foreign')
    await git(checkout.main, 'worktree', 'add', '-qb', 'foreign', foreign)
    checkout.registered.push({
      path: foreign,
      head: (await git(foreign, 'rev-parse', 'HEAD')).trim(),
      branch: 'refs/heads/foreign',
      isMainWorktree: false,
      isBare: false
    })
    await writeFile(join(checkout.path, '.git'), await readFile(join(foreign, '.git')))
    await orphan(checkout)
    await expectRuntimeOutcome(
      checkout,
      `Refusing to delete unregistered worktree path: ${checkout.path}`
    )
    expect(await readFile(join(foreign, 'preserved.txt'), 'utf8')).toBe(
      'preserved checkout bytes\n'
    )
  }
)

it.skipIf(process.platform === 'win32').each(['admin-read', 'owner-layout', 'home'])(
  'refuses orphan admission with unknown %s authority',
  async (failure) => {
    const checkout = await createCheckout()
    await orphan(checkout)
    const access = localFilesystem.getLocalWorktreePathAccess()
    const denied = Object.assign(new Error('Cannot inspect owning metadata'), { code: 'EACCES' })
    if (failure === 'admin-read') {
      vi.spyOn(localFilesystem, 'getLocalWorktreePathAccess').mockReturnValue({
        ...access,
        readPath: (path) =>
          path === join(checkout.admin, 'gitdir') ? Promise.reject(denied) : access.readPath(path)
      })
    } else if (failure === 'owner-layout') {
      vi.spyOn(localFilesystem, 'getLocalWorktreePathAccess').mockReturnValue({
        ...access,
        layoutStatPath: (path) =>
          path === join(checkout.repo.path, '.git')
            ? Promise.reject(denied)
            : access.layoutStatPath(path)
      })
    } else {
      vi.spyOn(removalRoute, 'resolveWorktreeRemovalHome').mockReturnValue(
        executionHostRemovalHome(null)
      )
    }
    await expectRuntimeOutcome(
      checkout,
      `Refusing to delete unregistered worktree path: ${checkout.path}`
    )
  }
)

it.skipIf(process.platform === 'win32')(
  'reads the complete candidate admin backlink and Git trailing whitespace',
  async () => {
    const checkout = await createCheckout('main', 'ordinary', 'check\nout')
    const backlink = join(checkout.admin, 'gitdir')
    expect(await readFile(backlink, 'utf8')).toBe(`${join(checkout.path, '.git')}\n`)
    await writeFile(backlink, `${join(checkout.path, '.git')}\t \r\n`)
    expect(await git(checkout.main, 'worktree', 'list', '--porcelain')).toContain(
      `worktree ${checkout.path}\n`
    )
    await expect(
      canSafelyRemoveOrphanedWorktreeDirectory(
        checkout.path,
        checkout.repo.path,
        CLIENT_REMOVAL_HOME
      )
    ).resolves.toBe(true)
    for (const suffix of ['\v', '\f', '\u00a0']) {
      await writeFile(backlink, `${join(checkout.path, '.git')}${suffix}\n`)
      expect(await git(checkout.main, 'worktree', 'list', '--porcelain')).not.toContain(
        `worktree ${checkout.path}\n`
      )
      await expect(
        canSafelyRemoveOrphanedWorktreeDirectory(
          checkout.path,
          checkout.repo.path,
          CLIENT_REMOVAL_HOME
        )
      ).resolves.toBe(false)
    }
    expect(await readFile(join(checkout.path, 'preserved.txt'), 'utf8')).toBe(
      'preserved checkout bytes\n'
    )
  }
)
