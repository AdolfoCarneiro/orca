import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GitRunner from './runner'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  return {
    ...actual,
    readFile: vi.fn(actual.readFile),
    stat: vi.fn(actual.stat),
    lstat: vi.fn(actual.lstat)
  }
})

vi.mock('./runner', async (importOriginal) => {
  const actual = await importOriginal<typeof GitRunner>()
  return { ...actual, gitExecFileAsyncBuffer: vi.fn(actual.gitExecFileAsyncBuffer) }
})

import { gitExecFileAsyncBuffer } from './runner'
import { getDiff } from './source-control/file-diff'
import {
  invalidateGitReadCaches,
  settledDiffCache
} from './source-control/git-read-cache-invalidation'
import { readWorktreeDiffStamp } from './source-control/worktree-diff-stamp'

const runBufferedGit = vi.mocked(gitExecFileAsyncBuffer).getMockImplementation()
if (!runBufferedGit) {
  throw new Error('real Git runner is missing')
}

let repo = ''
let base = ''
let replacement = ''
let secondReplacement = ''

async function git(args: string[], input?: string): Promise<string> {
  const result = await runProcess({
    program: 'git',
    args: ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', ...args],
    cwd: repo,
    env: process.env,
    input,
    timeoutMs: 15_000
  })
  if (result.code !== 0) {
    throw new Error(result.stderr)
  }
  return result.stdout
}

async function age(target: string): Promise<void> {
  const old = new Date('2000-01-01T00:00:00Z')
  await fs.utimes(target, old, old)
}

async function expectNativeDiff(): Promise<void> {
  const expected = await git(['show', 'HEAD:file.txt'])
  const result = await getDiff(repo, 'file.txt', true)
  expect(result.originalContent).toBe(expected)
  expect(result.modifiedContent).toBe('base\n')
}

beforeEach(async () => {
  repo = await fs.mkdtemp(join(tmpdir(), 'orca-diff-replacements-'))
  for (const key of Object.keys(process.env)) {
    if (key.toUpperCase().startsWith('GIT_')) {
      vi.stubEnv(key, undefined)
    }
  }
  const globalConfig = join(repo, 'global.gitconfig')
  await fs.writeFile(globalConfig, '')
  vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig)
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
  await git(['init', '--quiet'])
  await git(['symbolic-ref', 'HEAD', 'refs/heads/main'])
  await git(['config', 'commit.gpgsign', 'false'])
  const hooks = join(repo, 'hooks')
  await fs.mkdir(hooks)
  await git(['config', 'core.hooksPath', hooks])
  await fs.writeFile(join(repo, 'file.txt'), 'base\n')
  await git(['add', 'file.txt'])
  await git(['commit', '--quiet', '-m', 'base'])
  base = (await git(['rev-parse', 'HEAD'])).trim()
  const replacements: string[] = []
  for (const content of ['replacement\n', 'second replacement\n']) {
    const blob = (await git(['hash-object', '-w', '--stdin'], content)).trim()
    const tree = (await git(['mktree'], `100644 blob ${blob}\tfile.txt\n`)).trim()
    replacements.push((await git(['commit-tree', tree, '-m', content.trim()])).trim())
  }
  ;[replacement, secondReplacement] = replacements
  await age(join(repo, '.git', 'index'))
  await age(join(repo, '.git', 'refs'))
  invalidateGitReadCaches()
  settledDiffCache.resetStatsForTests()
  vi.mocked(gitExecFileAsyncBuffer).mockClear()
})

afterEach(async () => {
  vi.mocked(gitExecFileAsyncBuffer).mockImplementation(runBufferedGit)
  invalidateGitReadCaches()
  vi.unstubAllEnvs()
  await fs.rm(repo, { recursive: true, force: true })
})

describe('diff cache with default loose replacement refs', () => {
  it('keeps ordinary warm reads to eight filesystem operations and no Git reads', async () => {
    await expectNativeDiff()
    vi.mocked(gitExecFileAsyncBuffer).mockClear()
    vi.mocked(fs.readFile).mockClear()
    vi.mocked(fs.stat).mockClear()
    vi.mocked(fs.lstat).mockClear()

    const result = await getDiff(repo, 'file.txt', true)

    expect(result.originalContent).toBe('base\n')
    expect(gitExecFileAsyncBuffer).not.toHaveBeenCalled()
    expect(fs.readFile).toHaveBeenCalledTimes(4)
    expect(fs.stat).toHaveBeenCalledTimes(3)
    expect(fs.lstat).toHaveBeenCalledTimes(1)
    expect(settledDiffCache.stats().hits).toBe(1)
  })

  it('reads native bytes after replacement create, update, and delete without Orca invalidation', async () => {
    await expectNativeDiff()
    await getDiff(repo, 'file.txt', true)
    expect(settledDiffCache.stats().hits).toBe(1)

    await git(['replace', base, replacement])
    await expectNativeDiff()
    await git(['replace', '-f', base, secondReplacement])
    await expectNativeDiff()
    await git(['replace', '-d', base])
    await expectNativeDiff()

    expect(settledDiffCache.stats().hits).toBe(1)
  })

  it('does not rely on the top namespace mtime for nested ref updates', async () => {
    await expectNativeDiff()
    const ref = `refs/replace/nested/${base}`
    await git(['update-ref', ref, replacement])
    await expectNativeDiff()
    const namespace = join(repo, '.git', 'refs', 'replace')
    const before = await fs.stat(namespace)

    await git(['update-ref', ref, secondReplacement])

    expect((await fs.stat(namespace)).mtimeMs).toBe(before.mtimeMs)
    await expectNativeDiff()
    expect(settledDiffCache.stats().hits).toBe(0)
  })

  it('misses a transient replacement cached during an awaited blob read after its namespace is removed', async () => {
    let changed = false
    vi.mocked(gitExecFileAsyncBuffer).mockImplementation(async (args, options) => {
      if (changed || !args.includes('HEAD:file.txt')) {
        return runBufferedGit(args, options)
      }
      changed = true
      await git(['replace', base, replacement])
      const result = await runBufferedGit(args, options)
      await git(['replace', '-d', base])
      await fs.rmdir(join(repo, '.git', 'refs', 'replace'))
      return result
    })

    expect((await getDiff(repo, 'file.txt', true)).originalContent).toBe('replacement\n')
    expect(settledDiffCache.stats().stores).toBe(1)
    await expectNativeDiff()

    expect(changed).toBe(true)
    expect(settledDiffCache.stats().hits).toBe(0)
  })

  it('declines a visible custom namespace before any stamp filesystem reads', async () => {
    await expectNativeDiff()
    vi.stubEnv('GIT_REPLACE_REF_BASE', 'refs/custom-replace/')
    await git(['replace', base, replacement])
    await expectNativeDiff()
    vi.mocked(fs.readFile).mockClear()
    vi.mocked(fs.stat).mockClear()
    vi.mocked(fs.lstat).mockClear()

    expect(await readWorktreeDiffStamp(repo, 'file.txt', false)).toBeNull()
    expect(fs.readFile).not.toHaveBeenCalled()
    expect(fs.stat).not.toHaveBeenCalled()
    expect(fs.lstat).not.toHaveBeenCalled()
  })
})
