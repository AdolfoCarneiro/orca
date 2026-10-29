import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { runProcess } from '@orca/process-host'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getBranchDiff } from './branch-diff'
import { getCommitCompare } from './commit-compare'
import { getCommitDiff } from './commit-diff'
import { invalidateGitReadCaches } from './git-read-cache-invalidation'
import { MAX_GIT_SHOW_BYTES } from './git-show-max-bytes'

describe('historical gitlink content with real Git', () => {
  let directory: string
  let repo: string

  async function git(cwd: string, args: string[], input?: string): Promise<string> {
    const result = await runProcess({
      program: 'git',
      args,
      cwd,
      input,
      timeoutMs: 30_000,
      maxOutputBytes: 1024 * 1024,
      env: process.env
    })
    expect(result.code, result.stderr).toBe(0)
    expect(result.outputTruncated).toBe(false)
    expect(result.timedOut).toBe(false)
    return result.stdout
  }

  async function init(cwd: string): Promise<void> {
    await mkdir(cwd)
    await git(cwd, ['init', '-q'])
    await git(cwd, ['config', 'user.name', 'Test'])
    await git(cwd, ['config', 'user.email', 'test@example.test'])
    await git(cwd, ['config', 'commit.gpgsign', 'false'])
    await git(cwd, ['config', 'core.hooksPath', path.join(directory, 'empty-hooks')])
    expect(await realpath((await git(cwd, ['rev-parse', '--show-toplevel'])).trim())).toBe(
      await realpath(cwd)
    )
  }

  async function commit(message: string): Promise<string> {
    await git(repo, ['commit', '-qm', message])
    return (await git(repo, ['rev-parse', 'HEAD'])).trim()
  }

  async function setEntry(mode: string, oid: string, filePath: string): Promise<void> {
    await git(repo, ['update-index', '--add', '--cacheinfo', `${mode},${oid},${filePath}`])
  }

  async function expectContent(
    args: Parameters<typeof getCommitDiff>[1],
    expected: { originalContent: string; modifiedContent: string }
  ): Promise<void> {
    await expect.soft(getCommitDiff(repo, args)).resolves.toMatchObject(expected)
    if (args.parentOid) {
      await expect
        .soft(
          getBranchDiff(repo, {
            headOid: args.commitOid,
            mergeBase: args.parentOid,
            filePath: args.filePath,
            oldPath: args.oldPath
          })
        )
        .resolves.toMatchObject(expected)
    }
  }

  beforeEach(async () => {
    for (const key of Object.keys(process.env)) {
      if (key.toUpperCase().startsWith('GIT_')) {
        vi.stubEnv(key, undefined)
      }
    }
    directory = await mkdtemp(path.join(tmpdir(), 'orca-commit-gitlink-'))
    const emptyConfig = path.join(directory, 'empty-config')
    await writeFile(emptyConfig, '')
    await mkdir(path.join(directory, 'empty-hooks'))
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
    vi.stubEnv('GIT_CONFIG_GLOBAL', emptyConfig)
    repo = path.join(directory, 'parent')
    await init(repo)
    invalidateGitReadCaches()
  })

  afterEach(async () => {
    try {
      invalidateGitReadCaches()
      await rm(directory, { recursive: true, force: true })
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it.each([false, true])(
    'reads root/update/rename/delete and mode transitions with child objects present=%s',
    async (objectsPresent) => {
      const child = path.join(directory, 'child')
      await init(child)
      await writeFile(path.join(child, 'file.txt'), 'child one\n')
      await git(child, ['add', '.'])
      await git(child, ['commit', '-qm', 'child one'])
      const first = (await git(child, ['rev-parse', 'HEAD'])).trim()
      await writeFile(path.join(child, 'file.txt'), 'child two\n')
      await git(child, ['commit', '-qam', 'child two'])
      const second = (await git(child, ['rev-parse', 'HEAD'])).trim()
      if (objectsPresent) {
        await git(repo, ['fetch', '-q', child, second])
        expect((await git(repo, ['cat-file', '-t', first])).trim()).toBe('commit')
      } else {
        const absent = await runProcess({
          program: 'git',
          args: ['cat-file', '-e', first],
          cwd: repo
        })
        expect(absent.code).not.toBe(0)
      }

      const filePath = 'module[12]'
      await setEntry('160000', first, filePath)
      await setEntry('160000', second, 'module1')
      const root = await commit('root gitlinks')
      expect((await getCommitCompare(repo, root)).summary.parentOid).toBeNull()
      await expectContent(
        { commitOid: root, parentOid: null, filePath },
        { originalContent: '', modifiedContent: `Subproject commit ${first}\n` }
      )

      await setEntry('160000', second, filePath)
      const updated = await commit('update gitlink')
      await expectContent(
        { commitOid: updated, parentOid: root, filePath },
        {
          originalContent: `Subproject commit ${first}\n`,
          modifiedContent: `Subproject commit ${second}\n`
        }
      )

      const blob = (await git(repo, ['hash-object', '-w', '--stdin'], 'ordinary bytes\n')).trim()
      await setEntry('100644', blob, filePath)
      const toBlob = await commit('gitlink to blob')
      await expectContent(
        { commitOid: toBlob, parentOid: updated, filePath },
        { originalContent: `Subproject commit ${second}\n`, modifiedContent: 'ordinary bytes\n' }
      )

      await setEntry('160000', second, filePath)
      const toGitlink = await commit('blob to gitlink')
      await expectContent(
        { commitOid: toGitlink, parentOid: toBlob, filePath },
        { originalContent: 'ordinary bytes\n', modifiedContent: `Subproject commit ${second}\n` }
      )

      const renamedPath = 'renamed module'
      await git(repo, ['update-index', '--force-remove', '--', filePath])
      await setEntry('160000', second, renamedPath)
      const renamed = await commit('rename gitlink')
      const comparison = await getCommitCompare(repo, renamed)
      expect(comparison.entries).toContainEqual(
        expect.objectContaining({ path: renamedPath, oldPath: filePath, status: 'renamed' })
      )
      await expectContent(
        {
          commitOid: renamed,
          parentOid: toGitlink,
          filePath: renamedPath,
          oldPath: filePath
        },
        {
          originalContent: `Subproject commit ${second}\n`,
          modifiedContent: `Subproject commit ${second}\n`
        }
      )

      await git(repo, ['update-index', '--force-remove', '--', renamedPath])
      const deleted = await commit('delete gitlink')
      await expectContent(
        {
          commitOid: deleted,
          parentOid: renamed,
          filePath: renamedPath
        },
        { originalContent: `Subproject commit ${second}\n`, modifiedContent: '' }
      )

      await setEntry('160000', first, 'added module')
      const added = await commit('add gitlink')
      await expectContent(
        { commitOid: added, parentOid: deleted, filePath: 'added module' },
        { originalContent: '', modifiedContent: `Subproject commit ${first}\n` }
      )
    },
    30_000
  )

  it.each(['blob', 'tag'])('uses tree mode when a gitlink points at a present %s', async (type) => {
    await git(repo, ['commit', '--allow-empty', '-qm', 'before gitlink'])
    const parentOid = (await git(repo, ['rev-parse', 'HEAD'])).trim()
    const blob = (await git(repo, ['hash-object', '-w', '--stdin'], 'not pointer content\n')).trim()
    let target = blob
    if (type === 'tag') {
      await git(repo, ['tag', '-a', 'blob-target', blob, '-m', 'blob target'])
      target = (await git(repo, ['rev-parse', 'refs/tags/blob-target'])).trim()
    }
    expect((await git(repo, ['cat-file', '-t', target])).trim()).toBe(type)
    await setEntry('160000', target, 'module')
    const commitOid = await commit('non-commit gitlink target')
    expect(await git(repo, ['cat-file', 'blob', '--', `${commitOid}:module`])).toBe(
      'not pointer content\n'
    )
    await expectContent(
      { commitOid, parentOid, filePath: 'module' },
      { originalContent: '', modifiedContent: `Subproject commit ${target}\n` }
    )
  })

  it('preserves ordinary root, binary, and oversized content', async () => {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 255])
    await writeFile(path.join(repo, 'normal.txt'), 'ordinary root\n')
    await writeFile(path.join(repo, 'image.png'), png)
    await writeFile(path.join(repo, 'large.txt'), Buffer.alloc(MAX_GIT_SHOW_BYTES + 1, 0x61))
    await git(repo, ['add', '.'])
    const commitOid = await commit('ordinary controls')
    expect(
      await getCommitDiff(repo, { commitOid, parentOid: null, filePath: 'normal.txt' })
    ).toMatchObject({ originalContent: '', modifiedContent: 'ordinary root\n' })
    expect(
      await getCommitDiff(repo, { commitOid, parentOid: null, filePath: 'image.png' })
    ).toMatchObject({ kind: 'binary', isImage: true, modifiedContent: png.toString('base64') })
    expect(
      await getCommitDiff(repo, { commitOid, parentOid: null, filePath: 'large.txt' })
    ).toMatchObject({ kind: 'binary', tooLarge: true })
  })
})
