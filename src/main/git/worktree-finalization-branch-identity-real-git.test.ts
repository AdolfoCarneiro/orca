import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { quotePosixShell } from '../../shared/shell-argument-quoting'
import { createWorktreePreparationLockReason } from '../../shared/worktree/create-preparation'
import { clearGitCapabilityStateForTests } from './git-capability-state'
import { gitExecFileAsync } from './runner'
import {
  finalizePreparedWorktree,
  prepareWorktreeCreateCheckout
} from './worktree-create-preparation'

const roots: string[] = []

afterEach(async () => {
  clearGitCapabilityStateForTests()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe.skipIf(process.platform === 'win32')(
  'failed prepared branch cleanup with real Git',
  () => {
    it.each([
      'ordinary',
      'tag-collision',
      'heads-prefix',
      'hook-switch',
      'hook-detach',
      'foreign-lock'
    ])('cleans only the attached owned branch after %s', async (shape) => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'orca-finalize-branch-')))
      roots.push(root)
      const repo = join(root, 'repo')
      const prepared = join(root, 'prepared')
      const final = join(root, 'final')
      const hooks = join(root, 'hooks')
      const git = async (cwd: string, args: string[]) =>
        (await gitExecFileAsync(args, { cwd })).stdout.trim()
      await git(root, ['init', '-q', repo])
      await git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
      await git(repo, ['config', 'user.name', 'Test'])
      await git(repo, ['config', 'user.email', 'test@example.invalid'])
      await git(repo, ['config', 'core.hooksPath', ''])
      await git(repo, ['config', 'commit.gpgsign', 'false'])
      await writeFile(join(repo, 'tracked.txt'), 'preserved\n')
      await git(repo, ['add', '.'])
      await git(repo, ['commit', '-qm', 'seed'])
      const head = await git(repo, ['rev-parse', 'HEAD'])
      const index = await readFile(join(repo, '.git', 'index'))
      const branch = shape === 'heads-prefix' ? 'heads/feature' : 'feature'
      const collides = shape === 'tag-collision' || shape === 'heads-prefix'
      if (collides) {
        await git(repo, ['tag', branch])
      }
      if (shape === 'hook-switch') {
        await git(repo, ['branch', 'other'])
      }
      const reason = createWorktreePreparationLockReason('exact-branch')
      await prepareWorktreeCreateCheckout(repo, prepared, 'main', reason)
      const lock = await git(prepared, ['rev-parse', '--git-path', 'locked'])
      const hookCommand =
        shape === 'hook-switch'
          ? 'git -c core.hooksPath= checkout -q other\n'
          : shape === 'hook-detach'
            ? 'git -c core.hooksPath= checkout -q --detach HEAD\n'
            : shape === 'foreign-lock'
              ? `printf '%s\\n' 'foreign owner' > ${quotePosixShell(lock)}\n`
              : ''
      await mkdir(hooks)
      const hook = join(hooks, 'post-checkout')
      await writeFile(hook, `#!/bin/sh\n${hookCommand}exit 23\n`)
      await chmod(hook, 0o755)
      await git(repo, ['config', 'core.hooksPath', hooks])

      await expect(
        finalizePreparedWorktree(repo, prepared, final, branch, 'main', false, {}, reason)
      ).rejects.toThrow('checkout')

      const branchExists = await git(repo, [
        'show-ref',
        '--verify',
        '--quiet',
        `refs/heads/${branch}`
      ]).then(
        () => true,
        () => false
      )
      expect(branchExists).toBe(
        shape === 'hook-switch' || shape === 'hook-detach' || shape === 'foreign-lock'
      )
      expect((await git(repo, ['worktree', 'list', '--porcelain'])).includes(final)).toBe(
        shape === 'foreign-lock'
      )
      if (collides) {
        expect(await git(repo, ['rev-parse', `refs/tags/${branch}`])).toBe(head)
      }
      if (shape === 'hook-switch') {
        expect(await git(repo, ['rev-parse', 'refs/heads/other'])).toBe(head)
      }
      if (shape === 'foreign-lock') {
        expect(await readFile(lock, 'utf8')).toBe('foreign owner\n')
        expect(await readFile(join(final, 'tracked.txt'), 'utf8')).toBe('preserved\n')
      }
      expect(await git(repo, ['rev-parse', 'HEAD'])).toBe(head)
      expect(await readFile(join(repo, '.git', 'index'))).toEqual(index)
      expect(await readFile(join(repo, 'tracked.txt'), 'utf8')).toBe('preserved\n')
    })
  }
)
