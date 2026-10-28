import type * as ChildProcess from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createDivergentRepoFixture,
  type DivergentRepoFixture
} from '../../shared/git-object-quarantine-real-git.test-fixture'

const { execFileMock, execFileSyncMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  execFileSyncMock: vi.fn()
}))
vi.mock('node:child_process', async (importOriginal) => {
  const native = await importOriginal<typeof ChildProcess>()
  return {
    ...native,
    execFile: (...args: unknown[]) => execFileMock(native.execFile, ...args),
    execFileSync: (...args: unknown[]) => execFileSyncMock(native.execFileSync, ...args)
  }
})
vi.mock('../observability/instrumentation', () => ({
  withGitSpan: (_attributes: unknown, run: () => unknown) => run()
}))
vi.mock('../observability/tracer', () => ({
  withSpan: (_name: unknown, run: () => unknown) => run(),
  flushActiveSink: vi.fn(),
  startSpan: vi.fn()
}))
vi.mock('../diagnostics/main-thread-churn-probe', () => ({ recordSubprocessSpawn: vi.fn() }))

import {
  __resetPRConflictSummaryCachesForTests,
  getPRConflictSummary
} from '../github/conflict-summary'
import { deleteBranchAfterWorktreeRemoval } from './worktree-branch-removal'
import { disposeLocalRepoRefMaintenance } from './local-repo-ref-maintenance'
import { _resetGitAdmissionForTests } from './command-runner/git-subprocess-admission'
import { gitExecFileAsync } from './runner'

let root: string
let gitBinary: string
let version: string
let supportsMergeTree: boolean

async function snapshot(fixture: DivergentRepoFixture) {
  const files = await Promise.all(
    [fixture.repoPath, fixture.linkedPath].map(async (cwd) => {
      const names = fixture.git(cwd, 'ls-files', '-z').split('\0').filter(Boolean)
      return Promise.all(names.map(async (name) => readFile(join(cwd, name))))
    })
  )
  return {
    heads: [
      fixture.git(fixture.repoPath, 'rev-parse', 'HEAD'),
      fixture.git(fixture.linkedPath, 'rev-parse', 'HEAD')
    ],
    refs: fixture.git(fixture.repoPath, 'for-each-ref', '--format=%(refname) %(objectname)'),
    indexes: await Promise.all([
      readFile(join(fixture.commonDir, 'index')),
      readFile(join(fixture.commonDir, 'worktrees/linked/index'))
    ]),
    files
  }
}

describe.skipIf(process.platform === 'win32')(
  'quarantine consumers preserve newline common directories with real Git',
  () => {
    beforeAll(async () => {
      vi.stubEnv('ORCA_DISABLE_REPO_REF_MAINTENANCE', '1')
      const resolved = await runProcess({ program: '/bin/sh', args: ['-c', 'command -v git'] })
      gitBinary = process.env.ORCA_GIT_COMPAT_BINARY ?? resolved.stdout.trim()
      expect(isAbsolute(gitBinary)).toBe(true)
      root = await mkdtemp(join(tmpdir(), 'orca-quarantine-common-dir-'))
      const executed = await runProcess({ program: gitBinary, args: ['--version'], cwd: root })
      expect(executed.code).toBe(0)
      version = executed.stdout.trim()
      if (process.env.ORCA_GIT_COMPAT_VERSION) {
        expect(version).toBe(`git version ${process.env.ORCA_GIT_COMPAT_VERSION}`)
      }
      const match = /^git version (\d+)\.(\d+)/.exec(version)
      if (!match) {
        throw new Error(`unrecognized Git version: ${version}`)
      }
      const major = Number(match[1])
      const minor = Number(match[2])
      supportsMergeTree = major > 2 || (major === 2 && minor >= 38)
    })

    afterAll(async () => {
      await disposeLocalRepoRefMaintenance()
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    })

    beforeEach(() => {
      __resetPRConflictSummaryCachesForTests()
      execFileMock.mockImplementation(
        (native: typeof ChildProcess.execFile, command, args, options, callback) => {
          expect(command).toBe('git')
          return native(gitBinary, args, options, callback)
        }
      )
      execFileSyncMock.mockImplementation(
        (native: typeof ChildProcess.execFileSync, command, args, options) => {
          expect(command).toBe('git')
          return native(gitBinary, args, options)
        }
      )
    })

    afterEach(() => {
      _resetGitAdmissionForTests()
    })

    it.each(
      ['ordinary', 'line\nparent'].flatMap((name) =>
        ['main', 'linked'].flatMap((caller) =>
          ['conflict-summary', 'branch-cleanup'].map((consumer) => ({ name, caller, consumer }))
        )
      )
    )(
      'keeps preview objects out of the real store: $name, $caller, $consumer',
      async (testCase) => {
        const parent = join(root, testCase.name)
        await mkdir(parent, { recursive: true })
        const fixture = createDivergentRepoFixture(parent)
        try {
          const cwd = testCase.caller === 'main' ? fixture.repoPath : fixture.linkedPath
          expect((await gitExecFileAsync(['--version'], { cwd })).stdout.trim()).toBe(version)
          fixture.git(cwd, 'remote', 'add', 'origin', fixture.repoPath)
          fixture.git(cwd, 'config', 'branch.feature-extra.base', 'refs/heads/main')
          const base = fixture.git(cwd, 'rev-parse', 'main').trim()
          const firstHead = fixture.git(cwd, 'rev-parse', 'feature-conflict').trim()
          const extraHead = fixture.git(cwd, 'rev-parse', 'feature-extra').trim()
          await writeFile(join(fixture.linkedPath, 'conflict-only.txt'), 'second preview input\n')
          fixture.git(fixture.linkedPath, 'add', 'conflict-only.txt')
          fixture.git(fixture.linkedPath, 'commit', '--quiet', '-m', 'second preview input')
          const secondHead = fixture.git(cwd, 'rev-parse', 'feature-conflict').trim()
          fixture.git(cwd, 'gc', '--quiet', '--prune=now')

          const warmed = await getPRConflictSummary(cwd, 'main', base, firstHead)
          if (supportsMergeTree) {
            expect(warmed?.files).toEqual(['shared.txt'])
          } else {
            expect(warmed).toBeUndefined()
          }
          const looseBefore = fixture.looseObjectCount()
          const before = await snapshot(fixture)
          if (testCase.consumer === 'conflict-summary') {
            const summary = await getPRConflictSummary(cwd, 'main', base, secondHead)
            if (supportsMergeTree) {
              expect(summary?.files).toEqual(['shared.txt'])
            } else {
              expect(summary).toBeUndefined()
            }
          } else {
            expect(
              await deleteBranchAfterWorktreeRemoval(cwd, 'feature-extra', extraHead, {})
            ).toEqual({ preservedBranch: { branchName: 'feature-extra', head: extraHead } })
          }
          expect(fixture.looseObjectCount()).toBe(looseBefore)
          expect(fixture.scratchDirectories()).toEqual([])
          expect(await snapshot(fixture)).toEqual(before)
        } finally {
          fixture.dispose()
        }
      }
    )
  }
)
