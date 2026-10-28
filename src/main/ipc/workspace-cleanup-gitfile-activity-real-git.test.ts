import { runProcess } from '@orca/process-host'
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isWorkspaceOldForCleanup } from '../../shared/workspace-cleanup'
import { mergeWorktree } from './worktree-metadata-merge'
import { resolveWorkspaceCleanupActivityWorktree } from './workspace-cleanup-activity'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

describe.skipIf(process.platform === 'win32')('linked cleanup activity with real Git', () => {
  it.each(['ordinary', 'line\nbreak'])(
    'recognizes recent checkout activity below %j',
    async (name) => {
      const root = await mkdtemp(join(tmpdir(), 'orca-cleanup-gitfile-'))
      directories.push(root)
      const main = join(root, name)
      const linked = join(root, 'linked')
      const old = new Date('2000-01-01T00:00:00Z').getTime()
      const recent = new Date('2025-01-01T00:00:00Z').getTime()
      const git = async (cwd: string, args: string[], setup = false) => {
        const result = await runProcess({
          program: 'git',
          args,
          cwd,
          timeoutMs: 10_000,
          env: {
            ...process.env,
            HOME: join(root, 'missing-home'),
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_AUTHOR_DATE: new Date(setup ? old : recent).toISOString(),
            GIT_COMMITTER_DATE: new Date(setup ? old : recent).toISOString()
          }
        })
        expect(result.code, result.stderr).toBe(0)
        return result.stdout
      }
      await mkdir(main)
      await git(main, ['init', '-q'])
      await git(main, ['config', 'user.name', 'Test'])
      await git(main, ['config', 'user.email', 'test@example.test'])
      await git(main, ['config', 'core.hooksPath', ''])
      await git(main, ['config', 'commit.gpgsign', 'false'])
      await writeFile(join(main, 'file.txt'), 'preserved\n')
      await git(main, ['add', '.'])
      await git(main, ['commit', '-qm', 'old'], true)
      await git(main, ['worktree', 'add', '-qb', 'linked', linked], true)
      const admin = (await git(linked, ['rev-parse', '--absolute-git-dir'])).replace(/\n$/, '')
      for (const target of [
        linked,
        join(linked, '.git'),
        join(admin, 'HEAD'),
        join(admin, 'ORIG_HEAD')
      ]) {
        await utimes(target, old / 1000, old / 1000)
      }
      const worktree = {
        ...mergeWorktree(
          'repo',
          {
            path: linked,
            head: (await git(linked, ['rev-parse', 'HEAD'])).trim(),
            branch: 'refs/heads/linked',
            isMainWorktree: false,
            isBare: false
          },
          undefined
        ),
        lastActivityAt: old,
        createdAt: old
      }
      const route = { kind: 'local', hostId: 'local' } as const
      const before = await resolveWorkspaceCleanupActivityWorktree(route, worktree)
      expect(isWorkspaceOldForCleanup(before, recent)).toBe(true)

      await git(linked, ['checkout', '-qb', 'recent'])
      await utimes(join(admin, 'HEAD'), recent / 1000, recent / 1000)
      const head = await readFile(join(admin, 'HEAD'))
      const index = await readFile(join(admin, 'index'))
      const marker = await readFile(join(linked, '.git'))
      const after = await resolveWorkspaceCleanupActivityWorktree(route, worktree)
      expect(after.lastActivityAt).toBeGreaterThanOrEqual((await stat(join(admin, 'HEAD'))).mtimeMs)
      expect(isWorkspaceOldForCleanup(after, recent)).toBe(false)
      expect((await stat(linked)).mtimeMs).toBeCloseTo(old, 0)
      expect((await stat(join(linked, '.git'))).mtimeMs).toBeCloseTo(old, 0)
      expect(await readFile(join(admin, 'HEAD'))).toEqual(head)
      expect(await readFile(join(admin, 'index'))).toEqual(index)
      expect(await readFile(join(linked, '.git'))).toEqual(marker)
      expect(await readFile(join(linked, 'file.txt'), 'utf8')).toBe('preserved\n')
    }
  )
})
