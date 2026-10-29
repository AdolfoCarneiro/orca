import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitBinaryTestFixture } from '../../shared/git-binary.test-fixture'
import { resolveEffectiveGitUpstream } from '../../shared/git-effective-upstream'
import type { GitPushTarget } from '../../shared/worktree/types'
import { disposeLocalRepoRefMaintenance } from './local-repo-ref-maintenance'
import { gitPull, gitPush } from './remote'
import { getStatus } from './status'
import { getUpstreamStatus, invalidateGitUpstreamStatusReads } from './upstream'

// Real Git verifies missing-ref exit/stderr handling before a fork remote is materialized.
describe('getUpstreamStatus with a deferred (not-yet-materialized) fork remote', () => {
  const tempPaths: string[] = []

  afterEach(() => {
    for (const path of tempPaths.splice(0)) {
      rmSync(path, { recursive: true, force: true })
    }
  })

  it('reports the graceful "publish" state instead of 0 ahead/0 behind', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'orca-deferred-fork-remote-'))
    tempPaths.push(repoPath)
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd: repoPath, encoding: 'utf8' })

    git('init', '--quiet')
    git('config', 'user.name', 'Orca Test')
    git('config', 'user.email', 'orca@example.test')
    git('config', 'commit.gpgSign', 'false')
    git('config', 'core.hooksPath', '.git/no-hooks')
    writeFileSync(join(repoPath, 'fixture.txt'), 'base\n')
    git('add', 'fixture.txt')
    git('commit', '-m', 'base')
    git('branch', '-M', 'contributor/fix')

    // Persist a push target without adding its deferred remote.
    const pushTarget: GitPushTarget = {
      remoteName: 'pr-contributor-orca',
      branchName: 'contributor/fix',
      remoteUrl: 'git@github.com:contributor/orca.git'
    }

    const status = await getUpstreamStatus(repoPath, pushTarget)

    expect(status).toEqual({
      hasUpstream: false,
      upstreamName: 'pr-contributor-orca/contributor/fix',
      ahead: 0,
      behind: 0,
      hasConfiguredPushTarget: true
    })
  })
})

describe('URL-configured upstreams with native Git', () => {
  const fixtures: { root: string; binary: GitBinaryTestFixture }[] = []

  afterEach(async () => {
    await disposeLocalRepoRefMaintenance()
    invalidateGitUpstreamStatusReads()
    vi.unstubAllEnvs()
    for (const { root, binary } of fixtures.splice(0)) {
      await binary.stop()
      rmSync(root, { recursive: true, force: true })
    }
  })

  async function createUrlUpstream() {
    const root = mkdtempSync(join(tmpdir(), 'orca-url-upstream-'))
    const binary = new GitBinaryTestFixture(root)
    fixtures.push({ root, binary })
    const globalConfig = join(root, 'empty.gitconfig')
    writeFileSync(globalConfig, '')
    vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig)
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
    vi.stubEnv('GIT_ALLOW_PROTOCOL', 'file')
    await binary.start()
    const directory = join(binary.executionRoot, 'client')
    const origin = join(binary.executionRoot, 'origin.git')
    const fork = join(binary.executionRoot, 'fork.git')
    const url = pathToFileURL(fork).href
    const git = (args: string[], cwd = directory, input?: string) =>
      binary.exec(
        args,
        cwd,
        {
          GIT_AUTHOR_NAME: 'Orca Test',
          GIT_AUTHOR_EMAIL: 'orca@example.test',
          GIT_COMMITTER_NAME: 'Orca Test',
          GIT_COMMITTER_EMAIL: 'orca@example.test'
        },
        input
      )
    await git(['init', '-q', directory], binary.executionRoot)
    await git(['symbolic-ref', 'HEAD', 'refs/heads/topic'])
    await git(['config', 'commit.gpgSign', 'false'])
    await git(['config', 'core.hooksPath', '.git/no-hooks'])
    const commit = async (file: string, parent?: string) => {
      const blob = (
        await git(['hash-object', '-w', '--stdin'], directory, `${file}\n`)
      ).stdout.trim()
      const tree = (
        await git(['mktree'], directory, `100644 blob ${blob}\t${file}\n`)
      ).stdout.trim()
      return (
        await git(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', file])
      ).stdout.trim()
    }
    const base = await commit('base')
    const published = await commit('fork-correct', base)
    const wrongOrigin = await commit('origin-wrong', base)
    await git(['reset', '--hard', base])
    for (const [name, path] of [
      ['origin', origin],
      ['fork', fork]
    ]) {
      await git(['init', '--bare', '-q', path], binary.executionRoot)
      await git(['remote', 'add', name, name === 'fork' ? url : path])
    }
    await git([
      'push',
      '-q',
      'origin',
      `${base}:refs/heads/main`,
      `${wrongOrigin}:refs/heads/topic`
    ])
    await git(['push', '-q', 'fork', `${published}:refs/heads/topic`])
    await git(['fetch', '-q', 'fork'])
    return { directory, git, base, published, wrongOrigin, origin, fork, url }
  }

  it('recovers a native push URL after registration, keeps warm counts exact, and pulls the fork', async () => {
    const { directory, git, base, published, wrongOrigin, origin, fork, url } =
      await createUrlUpstream()
    await git(['update-ref', 'refs/heads/topic', base], fork)
    await git(['remote', 'remove', 'fork'])
    await git(['config', 'branch.topic.pushRemote', url])

    await gitPush(directory)

    expect((await git(['config', '--get', 'branch.topic.remote'])).stdout.trim()).toBe(url)
    expect((await git(['config', '--get', 'branch.topic.merge'])).stdout.trim()).toBe(
      'refs/heads/topic'
    )
    await git(['update-ref', 'refs/heads/topic', published], fork)
    await expect(getUpstreamStatus(directory)).rejects.toThrow(
      'not stored as a remote-tracking branch'
    )
    expect((await getStatus(directory, { includeLineStats: false })).upstreamStatus).toMatchObject({
      hasUpstream: false
    })
    await git(['remote', 'add', 'fork', url])
    await git(['fetch', '-q', 'fork'])

    const expected = { hasUpstream: true, upstreamName: 'fork/topic', ahead: 0, behind: 1 }
    expect(await getUpstreamStatus(directory)).toEqual(expected)
    expect((await getStatus(directory, { includeLineStats: false })).upstreamStatus).toEqual(
      expected
    )
    const config = (await git(['config', '--local', '--list', '-z'])).stdout
    const tags = ['fork/topic', 'remotes/fork/topic', 'refs/remotes/fork/topic']
    for (const tag of tags) {
      await git(['update-ref', `refs/tags/${tag}`, base])
      expect((await getStatus(directory, { includeLineStats: false })).upstreamStatus).toEqual(
        expected
      )
    }

    await gitPull(directory)

    expect((await git(['rev-parse', 'HEAD'])).stdout.trim()).toBe(published)
    expect((await git(['show', 'HEAD:fork-correct'])).stdout).toBe('fork-correct\n')
    expect((await git(['rev-parse', 'refs/heads/topic'], origin)).stdout.trim()).toBe(wrongOrigin)
    expect((await git(['rev-parse', 'refs/heads/topic'], fork)).stdout.trim()).toBe(published)
    expect((await git(['config', '--local', '--list', '-z'])).stdout).toBe(config)
    for (const tag of tags) {
      expect((await git(['rev-parse', `refs/tags/${tag}`])).stdout.trim()).toBe(base)
    }
    expect(await getUpstreamStatus(directory)).toEqual({ ...expected, behind: 0 })
  })

  it.each([
    'distinct merge values',
    'repeated merge values',
    'empty second merge value',
    'trim-changing remote',
    'custom fetch destination',
    'wrong inverse fetch source',
    'multiple positive mappings',
    'nonrecursive URL rewrite chain',
    'duplicate matching remotes',
    'leading-hyphen remote name'
  ])('preserves the native error for %s without an origin fallback', async (scenario) => {
    const { git, url, origin } = await createUrlUpstream()
    await git(['config', 'branch.topic.remote', url])
    await git(['config', 'branch.topic.merge', 'refs/heads/topic'])
    switch (scenario) {
      case 'distinct merge values':
        await git(['config', '--add', 'branch.topic.merge', 'refs/heads/other'])
        break
      case 'repeated merge values':
        await git(['config', '--add', 'branch.topic.merge', 'refs/heads/topic'])
        break
      case 'empty second merge value':
        await git(['config', '--add', 'branch.topic.merge', ''])
        break
      case 'trim-changing remote':
        await git(['config', 'branch.topic.remote', `${url} `])
        break
      case 'custom fetch destination':
        await git(['config', 'remote.fork.fetch', '+refs/heads/*:refs/custom/fork/*'])
        break
      case 'wrong inverse fetch source':
        await git(['config', 'remote.fork.fetch', '+refs/heads/other:refs/remotes/fork/topic'])
        break
      case 'multiple positive mappings':
        await git(['config', '--add', 'remote.fork.fetch', '+refs/heads/*:refs/custom/fork/*'])
        break
      case 'nonrecursive URL rewrite chain':
        await git(['config', `url.${pathToFileURL(origin).href}.insteadOf`, url])
        await git(['config', `url.${url}.insteadOf`, 'fork-alias:'])
        await git(['config', 'remote.fork.url', 'fork-alias:'])
        break
      case 'duplicate matching remotes':
        await git(['remote', 'add', 'other-fork', url])
        break
      case 'leading-hyphen remote name':
        await git(['remote', 'remove', 'fork'])
        await git(['remote', 'add', '--', '-fork', url])
        await git(['fetch', '-q', '--', '-fork'])
        break
    }
    let nativeError: unknown
    const commands: string[][] = []
    const runGit = async (args: string[]) => {
      commands.push(args)
      try {
        return await git(args)
      } catch (error) {
        if (args[0] === 'rev-parse') {
          nativeError = error
        }
        throw error
      }
    }

    const result = await resolveEffectiveGitUpstream(runGit).catch((error: unknown) => error)

    expect(nativeError).toBeInstanceOf(Error)
    expect(nativeError).toMatchObject({
      code: 128,
      message: expect.stringContaining('not stored as a remote-tracking branch')
    })
    expect(result).toBe(nativeError)
    expect(
      commands.some(
        (args) => args[0] === 'for-each-ref' && args.at(-1) === 'refs/remotes/origin/topic'
      )
    ).toBe(false)
  })
})
