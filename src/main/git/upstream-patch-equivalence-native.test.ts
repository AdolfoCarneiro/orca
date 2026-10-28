import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { gitExecFileAsync } from './runner'
import { getUpstreamStatus, invalidateGitUpstreamStatusReads } from './upstream'

const roots: string[] = []
const commitEnvironment = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
  GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z'
}

type HistoryShape = 'equivalent' | 'different' | 'merge' | 'empty' | 'same'

afterEach(async () => {
  invalidateGitUpstreamStatusReads()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function createHistory(shape: HistoryShape, count: number, subjectBytes = 128) {
  const root = await mkdtemp(join(tmpdir(), 'orca-upstream-markers-'))
  roots.push(root)
  const repo = join(root, 'repo')
  await mkdir(repo)
  const git = async (args: string[], stdin?: string) =>
    (
      await gitExecFileAsync(args, {
        cwd: repo,
        env: commitEnvironment,
        ...(stdin === undefined ? {} : { stdin })
      })
    ).stdout.trim()
  await git(['init', '-q'])
  await git(['config', 'core.hooksPath', ''])
  await git(['config', 'commit.gpgsign', 'false'])
  const treeFor = async (contents: string) => {
    const blob = await git(['hash-object', '-w', '--stdin'], contents)
    return git(['mktree'], `100644 blob ${blob}\tfile.txt\n`)
  }
  const commit = (tree: string, parents: string[], message: string) =>
    git(['commit-tree', tree, ...parents.flatMap((parent) => ['-p', parent])], `${message}\n`)
  const baseTree = await treeFor('base\n')
  const base = await commit(baseTree, [], 'base')
  let local = base
  let remote = base
  let tree = baseTree
  for (let index = 1; index <= count; index++) {
    const contents = `base\n${Array.from({ length: index }, (_, offset) => `increment-${offset + 1}\n`).join('')}`
    tree = shape === 'empty' ? baseTree : await treeFor(contents)
    local = await commit(tree, [local], `local-${index}`)
    const remoteTree =
      shape === 'different' && index === count ? await treeFor(`${contents}remote-only\n`) : tree
    remote = await commit(remoteTree, [remote], 'x'.repeat(subjectBytes))
  }
  if (shape === 'merge') {
    const side = await commit(await treeFor('base\nside\n'), [base], 'side')
    remote = await commit(tree, [remote, side], 'merge')
  }
  if (shape === 'same') {
    remote = local
  }
  await git(['update-ref', 'refs/heads/topic', local])
  await git(['symbolic-ref', 'HEAD', 'refs/heads/topic'])
  await git(['remote', 'add', 'origin', './unused-remote'])
  await git(['update-ref', 'refs/remotes/origin/topic', remote])
  await git(['config', 'branch.topic.remote', 'origin'])
  await git(['config', 'branch.topic.merge', 'refs/heads/topic'])
  return repo
}

async function expectBothTargets(
  repo: string,
  ahead: number,
  behind: number,
  patchEquivalent?: boolean
) {
  for (const target of [undefined, { remoteName: 'origin', branchName: 'topic' }]) {
    expect(await getUpstreamStatus(repo, target)).toEqual({
      hasUpstream: true,
      upstreamName: 'origin/topic',
      ahead,
      behind,
      ...(patchEquivalent === undefined ? {} : { behindCommitsArePatchEquivalent: patchEquivalent })
    })
  }
}

describe('patch equivalence through the real Git upstream loader', () => {
  it('recognizes equivalent rewritten history whose subjects exceed the Git capture cap', async () => {
    const repo = await createHistory('equivalent', 20, 600 * 1024)

    await expectBothTargets(repo, 20, 20, true)
  })

  it.each([
    ['equivalent', 2, 2, 2, true],
    ['different', 2, 2, 2, false],
    ['merge', 2, 2, 4, false],
    ['empty', 1, 1, 1, true],
    ['same', 2, 0, 0, undefined]
  ] as const)(
    'preserves %s history semantics',
    async (shape, count, ahead, behind, patchEquivalent) => {
      const repo = await createHistory(shape, count)

      await expectBothTargets(repo, ahead, behind, patchEquivalent)
    }
  )
})
