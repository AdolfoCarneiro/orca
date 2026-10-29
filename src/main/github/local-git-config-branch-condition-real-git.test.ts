import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { GitBinaryTestFixture } from '../../shared/git-binary.test-fixture'

vi.mock('../observability/instrumentation', () => ({
  withGitSpan: (_attributes: unknown, run: () => unknown) => run()
}))
vi.mock('../observability/tracer', () => ({
  withSpan: (_name: unknown, run: () => unknown) => run(),
  flushActiveSink: vi.fn(),
  startSpan: vi.fn()
}))
vi.mock('../diagnostics/main-thread-churn-probe', () => ({ recordSubprocessSpawn: vi.fn() }))

import { gitExecFileAsync } from '../git/runner'
import { _resetRemoteNameListingCache, listCachedRemoteNames } from '../git/remote-name-listing'
import {
  __resetLocalGitConfigSignatureCacheForTests,
  readLocalGitConfigSignature
} from './local-git-config-signature'
import { _resetOwnerRepoCache, getOwnerRepoForRemote } from './github-repository-identity'

let root = ''
let git: GitBinaryTestFixture

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'orca-config-branch-')))
  vi.stubEnv('GIT_CONFIG_GLOBAL', join(root, 'missing-global-config'))
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
  if (process.env.ORCA_GIT_COMPAT_BINARY) {
    vi.stubEnv(
      'PATH',
      `${dirname(process.env.ORCA_GIT_COMPAT_BINARY)}${delimiter}${process.env.PATH ?? ''}`
    )
  }
  git = new GitBinaryTestFixture(root)
  await git.start()
  const version = (await git.exec(['--version'])).stdout.trim()
  expect((await gitExecFileAsync(['--version'], { cwd: root })).stdout.trim()).toBe(version)
  if (process.env.ORCA_GIT_COMPAT_VERSION) {
    expect(version).toBe(`git version ${process.env.ORCA_GIT_COMPAT_VERSION}`)
  }
})

beforeEach(() => {
  _resetRemoteNameListingCache()
  _resetOwnerRepoCache()
  __resetLocalGitConfigSignatureCacheForTests()
})

afterAll(async () => {
  _resetRemoteNameListingCache()
  _resetOwnerRepoCache()
  __resetLocalGitConfigSignatureCacheForTests()
  vi.unstubAllEnvs()
  await git?.stop()
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
})

async function createRepo(condition: string, nested = false): Promise<string> {
  const repo = await mkdtemp(join(root, 'repo-'))
  const empty = join(repo, 'empty')
  await mkdir(empty)
  await git.exec(['init', '-q', `--template=${empty}`], repo)
  for (const [key, value] of [
    ['user.name', 'Fixture'],
    ['user.email', 'fixture@example.invalid'],
    ['commit.gpgsign', 'false'],
    ['core.hooksPath', empty]
  ]) {
    await git.exec(['config', key, value], repo)
  }
  await git.exec(['symbolic-ref', 'HEAD', 'refs/heads/before'], repo)
  await git.exec(['commit', '--allow-empty', '-qm', 'fixture'], repo)
  await git.exec(['branch', 'after'], repo)
  const beforeCondition = condition === 'onbranch:never' ? 'onbranch:*' : 'onbranch:before'
  const directives = `[includeIf "${beforeCondition}"] path = before.cfg\n[core][includeIf "${condition}"] path = after.cfg\n`
  if (nested) {
    await appendFile(join(repo, '.git/config'), '\n[include]\npath = nested.cfg\n')
    await writeFile(join(repo, '.git/nested.cfg'), directives)
  } else {
    await appendFile(join(repo, '.git/config'), `\n${directives}`)
  }
  await writeFile(
    join(repo, '.git/before.cfg'),
    '[remote "origin"]\nurl = https://github.com/before-org/project.git\n'
  )
  await writeFile(
    join(repo, '.git/after.cfg'),
    '[remote "origin"]\nurl = https://github.com/after-org/project.git\n[remote "upstream"]\nurl = https://github.com/upstream-org/project.git\n'
  )
  return repo
}

async function warmCaches(repo: string): Promise<void> {
  expect(await listCachedRemoteNames(repo)).toEqual(['origin'])
  expect(await getOwnerRepoForRemote(repo, 'origin')).toEqual({
    owner: 'before-org',
    repo: 'project'
  })
  expect(await getOwnerRepoForRemote(repo, 'upstream')).toBeNull()
}

async function expectRefreshed(repo: string): Promise<void> {
  expect((await git.exec(['remote', 'get-url', 'origin'], repo)).stdout.trim()).toBe(
    'https://github.com/after-org/project.git'
  )
  expect(await listCachedRemoteNames(repo)).toEqual(['origin', 'upstream'])
  expect(await getOwnerRepoForRemote(repo, 'origin')).toEqual({
    owner: 'after-org',
    repo: 'project'
  })
  expect(await getOwnerRepoForRemote(repo, 'upstream')).toEqual({
    owner: 'upstream-org',
    repo: 'project'
  })
}

describe.skipIf(Boolean(process.env.ORCA_GIT_COMPAT_IMAGE))(
  'branch-dependent local config with real Git',
  () => {
    it.each([
      { condition: 'onbranch:after', nested: false },
      { condition: 'onbranch:after*', nested: false },
      { condition: 'onbranch:after', nested: true }
    ])(
      'refreshes signed public caches at the same commit: $condition nested=$nested',
      async ({ condition, nested }) => {
        const repo = await createRepo(condition, nested)
        const configBefore = await readFile(join(repo, '.git/config'))
        const oid = (await git.exec(['rev-parse', 'HEAD'], repo)).stdout
        await warmCaches(repo)
        await git.exec(['checkout', '-q', 'after'], repo)
        expect((await git.exec(['rev-parse', 'HEAD'], repo)).stdout).toBe(oid)
        expect(await readFile(join(repo, '.git/config'))).toEqual(configBefore)
        await expectRefreshed(repo)
      }
    )

    it('tracks a linked worktree symbolic chain while raw HEAD stays unchanged', async () => {
      const repo = await createRepo('onbranch:after')
      const linked = join(root, 'linked')
      await git.exec(['worktree', 'add', '--detach', '-q', linked, 'HEAD'], repo)
      await git.exec(['symbolic-ref', 'refs/heads/alias', 'refs/heads/before'], linked)
      await git.exec(['symbolic-ref', 'HEAD', 'refs/heads/alias'], linked)
      const gitDir = (await git.exec(['rev-parse', '--git-dir'], linked)).stdout.trim()
      const head = await readFile(join(gitDir, 'HEAD'))
      const oid = (await git.exec(['rev-parse', 'HEAD'], linked)).stdout
      await warmCaches(linked)
      await git.exec(['symbolic-ref', 'refs/heads/alias', 'refs/heads/after'], linked)
      expect(await readFile(join(gitDir, 'HEAD'))).toEqual(head)
      expect((await git.exec(['rev-parse', 'HEAD'], linked)).stdout).toBe(oid)
      await expectRefreshed(linked)
    })

    it.each(['origin', 'upstream'])(
      'refreshes the signed owner cache independently: %s',
      async (remote) => {
        const repo = await createRepo('onbranch:after')
        expect(await getOwnerRepoForRemote(repo, remote)).toEqual(
          remote === 'origin' ? { owner: 'before-org', repo: 'project' } : null
        )
        await git.exec(['checkout', '-q', 'after'], repo)
        expect(await getOwnerRepoForRemote(repo, remote)).toEqual({
          owner: remote === 'origin' ? 'after-org' : 'upstream-org',
          repo: 'project'
        })
      }
    )

    it('keeps native results stable for a condition that never matches', async () => {
      const repo = await createRepo('onbranch:never')
      await warmCaches(repo)
      await git.exec(['checkout', '-q', 'after'], repo)
      expect((await git.exec(['remote', 'get-url', 'origin'], repo)).stdout.trim()).toBe(
        'https://github.com/before-org/project.git'
      )
      await warmCaches(repo)
    })

    it('keeps ordinary signature bytes unchanged across a same-commit branch switch', async () => {
      const repo = await createRepo('onbranch:after')
      const config = join(repo, '.git/config')
      await writeFile(
        config,
        '[remote "origin"]\nurl = https://github.com/before-org/project.git\n'
      )
      const before = await readLocalGitConfigSignature({ repoPath: repo })
      expect(before).toBeDefined()
      await git.exec(['checkout', '-q', 'after'], repo)
      expect(await readLocalGitConfigSignature({ repoPath: repo })).toBe(before)
    })
  }
)
