import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { GitBinaryTestFixture } from '../../shared/git-binary.test-fixture'

vi.mock('../observability/instrumentation', () => ({
  withGitSpan: (_attributes: unknown, run: () => unknown) => run()
}))
vi.mock('../diagnostics/main-thread-churn-probe', () => ({ recordSubprocessSpawn: vi.fn() }))

import { appendFolderToGitignore, findKnownHugeFolderPathsToIgnore } from './huge-folder-ignore'
import { gitExecFileAsync } from './runner'
import { getStatus } from './status'

describe.skipIf(Boolean(process.env.ORCA_GIT_COMPAT_IMAGE))(
  'huge-folder ignore with real Git',
  () => {
    let root = ''
    let git: GitBinaryTestFixture

    beforeAll(async () => {
      root = await realpath(await mkdtemp(join(tmpdir(), 'orca-huge-folder-ignore-')))
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

    afterAll(async () => {
      vi.unstubAllEnvs()
      await git?.stop()
      if (root) {
        await rm(root, { recursive: true, force: true })
      }
    })

    it.each([
      { name: 'later exact negation', config: 'dist/\n!dist/\n', count: 1_001 },
      { name: 'later wildcard negation', config: 'dist/\n!d*/\n', count: 3 },
      { name: 'later bare negation', config: 'dist\n!dist\n', count: 3 },
      { name: 'literal tab after the slash', config: 'dist/\t\n', count: 3 }
    ])('applies the ignore despite $name', async ({ config, count }) => {
      const repo = await mkdtemp(join(root, 'repo-'))
      await git.exec(['init', '-q', repo])
      const ignorePath = join(repo, '.gitignore')
      await writeFile(ignorePath, config)
      await mkdir(join(repo, 'dist'))
      await mkdir(join(repo, 'sibling'))
      await writeFile(join(repo, 'sibling', 'keep.txt'), 'preserved sibling\n')
      for (let index = 0; index < count; index += 64) {
        await Promise.all(
          Array.from({ length: Math.min(64, count - index) }, (_, offset) =>
            writeFile(join(repo, 'dist', `generated-${index + offset}.txt`), 'generated\n')
          )
        )
      }
      const head = await readFile(join(repo, '.git', 'HEAD'))
      const before = await getStatus(repo, { includeLineStats: false })
      expect(before.didHitLimit === true).toBe(count > 1_000)
      expect(await findKnownHugeFolderPathsToIgnore(repo)).toContain('dist')

      expect(await appendFolderToGitignore(repo, 'dist')).toBe(true)

      const after = await getStatus(repo, { includeLineStats: false })
      expect(after.didHitLimit).not.toBe(true)
      expect(after.entries.map((entry) => entry.path).sort()).toEqual([
        '.gitignore',
        'sibling/keep.txt'
      ])
      expect(await findKnownHugeFolderPathsToIgnore(repo)).not.toContain('dist')
      expect(await readFile(ignorePath, 'utf8')).toBe(`${config}dist/\n`)
      expect(await appendFolderToGitignore(repo, 'dist')).toBe(false)
      expect(await readFile(ignorePath, 'utf8')).toBe(`${config}dist/\n`)
      expect(await readFile(join(repo, 'dist', `generated-${count - 1}.txt`), 'utf8')).toBe(
        'generated\n'
      )
      expect(await readFile(join(repo, 'sibling', 'keep.txt'), 'utf8')).toBe('preserved sibling\n')
      expect(await readFile(join(repo, '.git', 'HEAD'))).toEqual(head)
    })

    it('preserves an effective existing rule and its following unrelated negation', async () => {
      const repo = await mkdtemp(join(root, 'repo-'))
      await git.exec(['init', '-q', repo])
      const config = 'dist/\n!vendor/\n'
      await writeFile(join(repo, '.gitignore'), config)
      await mkdir(join(repo, 'dist'))
      await writeFile(join(repo, 'dist', 'generated.txt'), 'preserved\n')

      expect(await findKnownHugeFolderPathsToIgnore(repo)).not.toContain('dist')
      expect(await appendFolderToGitignore(repo, 'dist')).toBe(false)
      expect(await readFile(join(repo, '.gitignore'), 'utf8')).toBe(config)
      expect(await readFile(join(repo, 'dist', 'generated.txt'), 'utf8')).toBe('preserved\n')
    })
  }
)
