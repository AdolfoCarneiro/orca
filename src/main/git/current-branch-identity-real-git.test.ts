import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { afterEach, describe, expect, it } from 'vitest'
import {
  getEffectiveGitUpstreamStatus,
  resolveEffectiveGitUpstream
} from '../../shared/git-effective-upstream'
import { loadGitHistoryFromExecutor } from '../../shared/git-history'
import { resolveConfiguredGitPushTarget } from '../../shared/git-push-target-resolution'
import { hasUsableHostedReviewPushTarget } from '../../shared/hosted-review-push-target'
import { resolveSourceControlCompareBaseRef } from '../../shared/source-control-base-ref-resolution'
import { ENGLISH_REMOTE_DROPDOWN_COPY } from '../../shared/source-control-dropdown-remote-copy'
import { buildSourceControlManualReviewUrl } from '../../renderer/src/components/right-sidebar/source-control/review/manual-review-url'
import { gitPull, gitPush } from './remote'
import { getUpstreamStatus } from './upstream'
import { getStatus } from './status'
import { disposeLocalRepoRefMaintenance } from './local-repo-ref-maintenance'
import { installRealWorkerThreadChildProcesses } from '../worker-thread-child-process/worker-thread-child-process-real.test-fixtures'

const directories: string[] = []
const branches = [
  { branch: 'ordinary', tag: false },
  { branch: 'heads/release', tag: false },
  { branch: 'release', tag: true },
  { branch: 'heads/release', tag: true }
]

afterEach(async () => {
  await disposeLocalRepoRefMaintenance()
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

async function createRepo(branch: string, tag: boolean) {
  const directory = await mkdtemp(join(tmpdir(), 'orca-current-branch-'))
  directories.push(directory)
  const git = async (args: string[], cwd = directory, input?: string) => {
    const result = await runProcess({ program: 'git', args, cwd, input, timeoutMs: 30_000 })
    if (result.code !== 0) {
      throw new Error(result.stderr)
    }
    return { stdout: result.stdout }
  }
  await git(['init', '-q'])
  await git(['symbolic-ref', 'HEAD', `refs/heads/${branch}`])
  await git(['config', 'user.name', 'Audit'])
  await git(['config', 'user.email', 'audit@example.test'])
  await git(['config', 'commit.gpgsign', 'false'])
  await git(['config', 'core.hooksPath', ''])
  await git(['commit', '--allow-empty', '-qm', 'base'])
  const base = (await git(['rev-parse', 'HEAD'])).stdout.trim()
  if (tag) {
    await git(['tag', branch])
  }
  await git(['commit', '--allow-empty', '-qm', 'feature'])
  const head = (await git(['rev-parse', 'HEAD'])).stdout.trim()
  const origin = join(directory, 'origin.git')
  const fork = join(directory, 'fork.git')
  for (const [name, path] of [
    ['origin', origin],
    ['fork', fork]
  ] as const) {
    await git(['init', '--bare', '-q', path])
    await git(['remote', 'add', name, path])
  }
  await git(['update-ref', 'refs/remotes/origin/main', base])
  await git(['update-ref', `refs/remotes/origin/${branch}`, head])
  return { directory, git, base, head, origin, fork }
}

describe.each(branches)('current branch $branch, tag=$tag', ({ branch, tag }) => {
  it('pushes to the configured fork and destination', async () => {
    const { directory, git, head, origin, fork } = await createRepo(branch, tag)
    await git(['config', `branch.${branch}.remote`, 'fork'])
    await git(['config', `branch.${branch}.merge`, 'refs/heads/published'])

    await gitPush(directory)

    expect((await git(['for-each-ref', '--format=%(refname)', 'refs/heads/'], origin)).stdout).toBe(
      ''
    )
    expect((await git(['rev-parse', '--verify', 'refs/heads/published'], fork)).stdout.trim()).toBe(
      head
    )
    expect((await git(['symbolic-ref', 'HEAD'])).stdout.trim()).toBe(`refs/heads/${branch}`)
  })

  it('resolves a published same-name upstream over legacy origin/main tracking', async () => {
    const { git } = await createRepo(branch, tag)
    await git(['config', `branch.${branch}.remote`, 'origin'])
    await git(['config', `branch.${branch}.merge`, 'refs/heads/main'])

    expect(await getEffectiveGitUpstreamStatus(git)).toEqual({
      hasUpstream: true,
      upstreamName: `origin/${branch}`,
      ahead: 0,
      behind: 0
    })
  })

  it('keeps the current history reference exact', async () => {
    const { directory, git, head } = await createRepo(branch, tag)
    const history = await loadGitHistoryFromExecutor(git, directory)

    expect(history.currentRef).toEqual({
      id: `refs/heads/${branch}`,
      name: branch,
      revision: head,
      category: 'branches'
    })
    expect(history.items.some((item) => item.id === head)).toBe(true)
  })
})

it('preserves detached history and does not infer a branch push target', async () => {
  const { directory, git, head } = await createRepo('release', true)
  await git(['config', 'branch.release.remote', 'fork'])
  await git(['config', 'branch.release.merge', 'refs/heads/published'])
  await git(['checkout', '--detach', '-q', head])

  expect(await resolveConfiguredGitPushTarget(git)).toBeNull()
  expect(await getEffectiveGitUpstreamStatus(git)).toEqual({
    hasUpstream: false,
    ahead: 0,
    behind: 0
  })
  const history = await loadGitHistoryFromExecutor(git, directory)
  expect(history.currentRef).toEqual({
    id: head,
    name: head.slice(0, 7),
    revision: head,
    category: 'commits'
  })
})

describe('qualified configured upstreams with real Git', () => {
  it.each([0, 1, 2])(
    'keeps status and Pull on the published topic with %i colliding tags',
    async (tags) => {
      const { directory, git, base, head, origin } = await createRepo('topic', false)
      const tree = (await git(['rev-parse', 'HEAD^{tree}'])).stdout.trim()
      const published = (
        await git(['commit-tree', tree, '-p', head, '-m', 'published topic'])
      ).stdout.trim()
      await git([
        'push',
        '-q',
        'origin',
        `${base}:refs/heads/main`,
        `${published}:refs/heads/topic`
      ])
      await git(['update-ref', 'refs/remotes/origin/topic', published])
      await git(['config', 'branch.topic.remote', 'origin'])
      await git(['config', 'branch.topic.merge', 'refs/heads/main'])
      const tagNames = ['origin/main', 'remotes/origin/main'].slice(0, tags)
      for (const tag of tagNames) {
        await git(['update-ref', `refs/tags/${tag}`, head])
      }

      expect(await resolveEffectiveGitUpstream(git)).toEqual({
        upstreamName: 'origin/topic',
        remoteName: 'origin',
        branchName: 'topic',
        isConfiguredUpstream: false
      })
      const expected = { hasUpstream: true, upstreamName: 'origin/topic', ahead: 0, behind: 1 }
      expect(await getUpstreamStatus(directory)).toEqual(expected)
      expect(
        (
          await getStatus(directory, {
            includeLineStats: false,
            bypassEffectiveUpstreamNegativeCache: true
          })
        ).upstreamStatus
      ).toEqual(expected)
      expect((await getStatus(directory, { includeLineStats: false })).upstreamStatus).toEqual(
        expected
      )

      await gitPull(directory)

      expect((await git(['rev-parse', 'HEAD'])).stdout.trim()).toBe(published)
      expect((await git(['rev-parse', 'refs/heads/main'], origin)).stdout.trim()).toBe(base)
      expect((await git(['rev-parse', 'refs/heads/topic'], origin)).stdout.trim()).toBe(published)
      for (const tag of tagNames) {
        expect((await git(['rev-parse', `refs/tags/${tag}`])).stdout.trim()).toBe(head)
      }
    }
  )

  it.each(['remotes', 'origin/team'])(
    'preserves the exact configured remote %s under tag ambiguity',
    async (remoteName) => {
      const { git, base, head, origin } = await createRepo('topic', false)
      await git(['config', `remote.${remoteName}.url`, origin])
      await git([
        'config',
        `remote.${remoteName}.fetch`,
        `+refs/heads/*:refs/remotes/${remoteName}/*`
      ])
      await git(['update-ref', `refs/remotes/${remoteName}/main`, base])
      await git(['update-ref', `refs/tags/${remoteName}/main`, head])
      await git(['config', 'branch.topic.remote', remoteName])
      await git(['config', 'branch.topic.merge', 'refs/heads/main'])

      expect(await resolveEffectiveGitUpstream(git)).toMatchObject({
        remoteName,
        branchName: 'main',
        isConfiguredUpstream: true
      })
      expect(await getEffectiveGitUpstreamStatus(git)).toMatchObject({ ahead: 1, behind: 0 })
    }
  )

  it('keeps an ambiguity-qualified slash-named local upstream local', async () => {
    const { git, base, head } = await createRepo('topic', false)
    await git(['update-ref', 'refs/heads/origin/base', base])
    await git(['update-ref', 'refs/tags/origin/base', head])
    await git(['config', 'branch.topic.remote', '.'])
    await git(['config', 'branch.topic.merge', 'refs/heads/origin/base'])

    expect(await resolveEffectiveGitUpstream(git)).toEqual({
      upstreamName: 'heads/origin/base',
      remoteName: null,
      branchName: 'origin/base',
      isConfiguredUpstream: true
    })
    expect(await getEffectiveGitUpstreamStatus(git)).toMatchObject({ ahead: 1, behind: 0 })
  })

  it('keeps a configured non-branch source instead of selecting the published topic', async () => {
    const { directory, git, base, head, origin } = await createRepo('topic', false)
    const tree = (await git(['rev-parse', 'HEAD^{tree}'])).stdout.trim()
    const published = (
      await git(['commit-tree', tree, '-p', head, '-m', 'published topic'])
    ).stdout.trim()
    await git(['push', '-q', 'origin', `${base}:refs/changes/1`, `${published}:refs/heads/topic`])
    await git(['update-ref', 'refs/remotes/origin/topic', published])
    await git([
      'config',
      '--add',
      'remote.origin.fetch',
      '+refs/changes/*:refs/remotes/origin/change/*'
    ])
    await git(['update-ref', 'refs/remotes/origin/change/1', base])
    await git(['update-ref', 'refs/tags/origin/change/1', head])
    await git(['config', 'branch.topic.remote', 'origin'])
    await git(['config', 'branch.topic.merge', 'refs/changes/1'])

    expect(await resolveEffectiveGitUpstream(git)).toEqual({
      upstreamName: 'remotes/origin/change/1',
      remoteName: 'origin',
      branchName: 'refs/changes/1',
      isConfiguredUpstream: true
    })
    expect(await getEffectiveGitUpstreamStatus(git)).toMatchObject({ ahead: 1, behind: 0 })

    await gitPull(directory)

    expect((await git(['rev-parse', 'HEAD'])).stdout.trim()).toBe(head)
    expect((await git(['rev-parse', 'refs/tags/origin/change/1'])).stdout.trim()).toBe(head)
    expect((await git(['rev-parse', 'refs/changes/1'], origin)).stdout.trim()).toBe(base)
    expect((await git(['rev-parse', 'refs/heads/topic'], origin)).stdout.trim()).toBe(published)
  })

  it('uses the canonical custom destination when abbreviated upstream output is empty', async () => {
    const { directory, git, base, head } = await createRepo('topic', false)
    await git(['push', '-q', 'origin', `${base}:refs/heads/main`])
    await git(['config', 'remote.origin.fetch', '+refs/heads/*:refs/custom/*'])
    await git(['update-ref', '-d', 'refs/remotes/origin/main'])
    await git(['update-ref', '-d', 'refs/remotes/origin/topic'])
    await git(['update-ref', 'refs/custom/main', base])
    await git(['update-ref', 'refs/tags/custom/main', head])
    await git(['config', 'branch.topic.remote', 'origin'])
    await git(['config', 'branch.topic.merge', 'refs/heads/main'])

    expect(await resolveEffectiveGitUpstream(git)).toEqual({
      upstreamName: 'refs/custom/main',
      remoteName: 'origin',
      branchName: 'main',
      isConfiguredUpstream: true
    })
    expect(await getEffectiveGitUpstreamStatus(git)).toMatchObject({ ahead: 1, behind: 0 })

    await gitPull(directory)

    expect((await git(['rev-parse', 'HEAD'])).stdout.trim()).toBe(head)
    expect((await git(['rev-parse', 'refs/tags/custom/main'])).stdout.trim()).toBe(head)
  })
})

describe('same-name fallback upstream identity with real Git', () => {
  async function publishedBranch(branch = 'topic', legacy = true) {
    const fixture = await createRepo(branch, false)
    const { directory, git, base, head } = fixture
    const blob = (
      await git(['hash-object', '-w', '--stdin'], directory, 'published\n')
    ).stdout.trim()
    const tree = (
      await git(['mktree'], directory, `100644 blob ${blob}\tpublished.txt\n`)
    ).stdout.trim()
    const published = (
      await git(['commit-tree', tree, '-p', head, '-m', 'published'])
    ).stdout.trim()
    await git([
      'push',
      '-q',
      'origin',
      `${base}:refs/heads/main`,
      `${published}:refs/heads/${branch}`
    ])
    await git(['update-ref', `refs/remotes/origin/${branch}`, published])
    if (legacy) {
      await git(['config', `branch.${branch}.remote`, 'origin'])
      await git(['config', `branch.${branch}.merge`, 'refs/heads/main'])
    }
    return { ...fixture, published }
  }

  it.each([
    { legacy: true, tags: 1, nonStrict: false },
    { legacy: true, tags: 3, nonStrict: false },
    { legacy: true, tags: 2, nonStrict: true },
    { legacy: false, tags: 2, nonStrict: false }
  ])(
    'counts and pulls the published branch with $tags tags, legacy=$legacy, nonStrict=$nonStrict',
    async ({ legacy, tags, nonStrict }) => {
      const { directory, git, base, head, origin, published } = await publishedBranch(
        'topic',
        legacy
      )
      if (nonStrict) {
        await git(['config', 'core.warnAmbiguousRefs', 'false'])
      }
      const tagNames = ['origin/topic', 'remotes/origin/topic', 'refs/remotes/origin/topic'].slice(
        0,
        tags
      )
      for (const tag of tagNames) {
        await git(['update-ref', `refs/tags/${tag}`, head])
      }
      const upstream = await resolveEffectiveGitUpstream(git)
      expect(upstream).toEqual({
        upstreamName: 'origin/topic',
        remoteName: 'origin',
        branchName: 'topic',
        isConfiguredUpstream: false
      })
      const expected = { hasUpstream: true, upstreamName: 'origin/topic', ahead: 0, behind: 1 }
      expect(await getUpstreamStatus(directory)).toEqual(expected)
      expect(
        (
          await getStatus(directory, {
            includeLineStats: false,
            bypassEffectiveUpstreamNegativeCache: true
          })
        ).upstreamStatus
      ).toEqual(expected)
      expect((await getStatus(directory, { includeLineStats: false })).upstreamStatus).toEqual(
        expected
      )
      expect(
        buildSourceControlManualReviewUrl({
          baseRef: 'origin/main',
          branchName: 'topic',
          repoRemoteName: 'origin',
          repoRemoteUrl: 'https://github.com/stablyai/orca.git',
          provider: 'github',
          upstreamName: upstream?.upstreamName
        })
      ).toBe('https://github.com/stablyai/orca/compare/main...topic?expand=1')
      expect(
        hasUsableHostedReviewPushTarget({
          pushTarget: { remoteName: 'origin', branchName: 'topic' },
          upstreamStatus: expected
        })
      ).toBe(true)
      expect(ENGLISH_REMOTE_DROPDOWN_COPY.nothingToPushTo(expected.upstreamName)).toBe(
        'Nothing to push to origin/topic'
      )
      expect(
        resolveSourceControlCompareBaseRef({ enabled: true, upstreamName: expected.upstreamName })
      ).toBe('origin/topic')

      await gitPull(directory)

      expect((await git(['rev-parse', 'HEAD'])).stdout.trim()).toBe(published)
      expect(await readFile(join(directory, 'published.txt'), 'utf8')).toBe('published\n')
      expect((await git(['rev-parse', 'refs/heads/main'], origin)).stdout.trim()).toBe(base)
      expect((await git(['rev-parse', 'refs/heads/topic'], origin)).stdout.trim()).toBe(published)
      for (const tag of tagNames) {
        expect((await git(['rev-parse', `refs/tags/${tag}`])).stdout.trim()).toBe(head)
      }
      expect(await getUpstreamStatus(directory)).toEqual({ ...expected, behind: 0 })
      expect((await getStatus(directory, { includeLineStats: false })).upstreamStatus).toEqual({
        ...expected,
        behind: 0
      })
    }
  )

  it.each([true, false])(
    'keeps a warm fallback comparison exact when tags appear, legacy=%s',
    async (legacy) => {
      const { directory, git, head } = await publishedBranch('topic', legacy)
      const expected = { hasUpstream: true, upstreamName: 'origin/topic', ahead: 0, behind: 1 }
      expect((await getStatus(directory, { includeLineStats: false })).upstreamStatus).toEqual(
        expected
      )
      for (const tag of ['origin/topic', 'remotes/origin/topic', 'refs/remotes/origin/topic']) {
        await git(['update-ref', `refs/tags/${tag}`, head])
        expect((await getStatus(directory, { includeLineStats: false })).upstreamStatus).toEqual(
          expected
        )
      }
    }
  )

  it.each(['!', '-', '+', ']', '(', ')', 'é', '😀'])(
    'resolves a valid fallback branch ending in %s',
    async (suffix) => {
      const branch = `topic${suffix}`
      const { directory, git } = await publishedBranch(branch)
      expect(await resolveEffectiveGitUpstream(git)).toEqual({
        upstreamName: `origin/${branch}`,
        remoteName: 'origin',
        branchName: branch,
        isConfiguredUpstream: false
      })
      expect(await getUpstreamStatus(directory)).toEqual({
        hasUpstream: true,
        upstreamName: `origin/${branch}`,
        ahead: 0,
        behind: 1
      })
    }
  )

  it('rejects a child-only tracking ref and preserves the checkout on failed Pull', async () => {
    const { directory, git, head, published } = await publishedBranch('topic', false)
    await git(['update-ref', '-d', 'refs/remotes/origin/topic'])
    await git(['update-ref', 'refs/remotes/origin/topic/child', published])
    expect(await resolveEffectiveGitUpstream(git)).toBeNull()
    expect(await getUpstreamStatus(directory)).toEqual({ hasUpstream: false, ahead: 0, behind: 0 })
    for (let poll = 0; poll < 2; poll++) {
      expect((await getStatus(directory, { includeLineStats: false })).upstreamStatus).toEqual({
        hasUpstream: false,
        ahead: 0,
        behind: 0
      })
    }
    await expect(gitPull(directory)).rejects.toThrow()
    expect((await git(['rev-parse', 'HEAD'])).stdout.trim()).toBe(head)
    expect((await git(['rev-parse', 'refs/remotes/origin/topic/child'])).stdout.trim()).toBe(
      published
    )
    await expect(readFile(join(directory, 'published.txt'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })
})

installRealWorkerThreadChildProcesses()
