import { EventEmitter } from 'node:events'
import type * as ChildProcess from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { quotePosixShell } from '../../shared/shell-argument-quoting'

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcess>()),
  execFile: execFileMock
}))
vi.mock('../observability/instrumentation', () => ({
  withGitSpan: (_attributes: unknown, run: () => unknown) => run()
}))
vi.mock('../diagnostics/main-thread-churn-probe', () => ({ recordSubprocessSpawn: vi.fn() }))

import { PRUNE_GUARD_LOCK_REASON, pruneGitWorktrees } from './worktree-prune-guard'
import { _resetGitAdmissionForTests } from './command-runner/git-subprocess-admission'
import { resetWslGitReadEnvironmentForTests } from './wsl-git-read-environment'

const nativePlatform = process.platform
const banner = 'To run a command as administrator, use sudo.\n\n'
const userLock = 'user lock preserved\n'
const entryNames = ['foreign', 'user-locked', 'stale-local']
let fixture: string
let repo: string
let admin: string
let wrapper: string
let gitVersion: string
let realExecFile: typeof ChildProcess.execFile
let showBanner = false
let probeCount = 0
let shellVersions: string[] = []
let pruneOutput = ''
let locksAtPrune: string[] = []
let snapshotBefore: { path: string; bytes: Buffer }[]

async function git(...args: string[]): Promise<string> {
  const result = await runProcess({ program: 'git', args, cwd: repo, timeoutMs: 10_000 })
  expect(result.code, result.stderr).toBe(0)
  return result.stdout
}

async function readFixtureFiles(directory: string, relative = '') {
  const files: { path: string; bytes: Buffer }[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const relativePath = join(relative, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await readFixtureFiles(path, relativePath)))
    } else {
      files.push({ path: relativePath, bytes: await readFile(path) })
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path))
}

describe.skipIf(nativePlatform === 'win32')('WSL prune guard with actual generated shells', () => {
  beforeAll(async () => {
    realExecFile = (await vi.importActual<typeof ChildProcess>('node:child_process')).execFile
    fixture = await mkdtemp(join(tmpdir(), 'orca-prune-banner-'))
    repo = join(fixture, 'repo')
    admin = join(repo, '.git', 'worktrees')
    wrapper = join(fixture, 'dry-run-git')
    await mkdir(repo)
    await git('init', '-q')
    await git('config', 'user.name', 'Test')
    await git('config', 'user.email', 'test@example.test')
    await git('config', 'commit.gpgsign', 'false')
    await git('config', 'core.hooksPath', '')
    await git('config', 'gc.worktreePruneExpire', '2.weeks.ago')
    await writeFile(join(repo, 'file.txt'), 'preserved working bytes\n')
    await git('add', '.')
    await git('commit', '-qm', 'fixture')
    for (const name of entryNames) {
      await git('worktree', 'add', '-qb', name, join(fixture, name))
    }
    await writeFile(join(admin, 'foreign', 'gitdir'), 'C:/orca-test/foreign/.git\n')
    await writeFile(join(admin, 'user-locked', 'gitdir'), 'C:/orca-test/user-locked/.git\n')
    await writeFile(join(admin, 'user-locked', 'locked'), userLock)
    await rename(join(fixture, 'stale-local'), join(fixture, 'parked-local'))
    const expired = new Date('2000-01-01T00:00:00Z')
    for (const name of entryNames) {
      await utimes(join(admin, name, 'gitdir'), expired, expired)
      await utimes(join(admin, name), expired, expired)
    }
    const resolvedGit = await runProcess({
      program: '/bin/sh',
      args: ['-c', 'command -v git'],
      cwd: repo
    })
    expect(resolvedGit.code, resolvedGit.stderr).toBe(0)
    const binary = quotePosixShell(resolvedGit.stdout.trim())
    gitVersion = (await git('--version')).trim()
    await writeFile(
      wrapper,
      [
        '#!/bin/sh',
        `printf 'ORCA_TEST_GIT_VERSION=' >&2; ${binary} --version >&2`,
        'case "$1 $2" in',
        `  'rev-parse --git-common-dir') exec ${binary} "$@" ;;`,
        `  'worktree prune') shift 2; exec ${binary} worktree prune --dry-run --verbose "$@" ;;`,
        '  *) exit 99 ;;',
        'esac'
      ].join('\n'),
      { mode: 0o755 }
    )
    snapshotBefore = await readFixtureFiles(fixture)
  })

  afterAll(async () => {
    if (fixture) {
      await rm(fixture, { recursive: true, force: true })
    }
  })

  beforeEach(() => {
    execFileMock.mockReset()
    resetWslGitReadEnvironmentForTests()
    probeCount = 0
    shellVersions = []
    locksAtPrune = []
    pruneOutput = ''
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    execFileMock.mockImplementation((command, args, options, callback) => {
      expect(command).toBe('wsl.exe')
      const script = String(args.at(-1))
      if (script.includes('_orca_git_path=')) {
        probeCount++
        const child = Object.assign(new EventEmitter(), {
          stdout: new EventEmitter(),
          stderr: new EventEmitter()
        })
        queueMicrotask(() => {
          callback(Object.assign(new Error('profile requires login'), { code: 78 }), '', '')
          child.emit('close', 78)
        })
        return child
      }
      const nested = (value: string) => value.replaceAll("'", "'\\''")
      const routed = script.replaceAll(nested("'git' "), nested(`${quotePosixShell(wrapper)} `))
      expect(routed).not.toBe(script)
      const isPrune = script.includes(nested("'worktree' 'prune'"))
      const prefix = showBanner ? `printf %s ${quotePosixShell(banner)}; ` : ''
      return realExecFile(
        '/bin/sh',
        ['-c', `${prefix}exec /bin/sh -lc "$1"`, 'orca-test-wsl', routed],
        { ...options, cwd: repo, encoding: 'utf8' },
        async (error, stdout, stderr) => {
          const output = String(stdout)
          const errors = String(stderr)
          if (isPrune) {
            locksAtPrune = await Promise.all(
              entryNames.map((name) =>
                readFile(join(admin, name, 'locked'), 'utf8').catch(() => '')
              )
            )
            pruneOutput = output + errors
          }
          shellVersions.push(/^ORCA_TEST_GIT_VERSION=(.+)$/m.exec(errors)?.[1] ?? '')
          callback(error, output, errors.replace(/^ORCA_TEST_GIT_VERSION=.+\n/m, ''))
        }
      )
    })
  })

  afterEach(async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: nativePlatform })
    resetWslGitReadEnvironmentForTests()
    _resetGitAdmissionForTests()
    expect(await readFixtureFiles(fixture)).toEqual(snapshotBefore)
  })

  it.each([false, true])(
    'protects foreign metadata while identifying stale local entries, banner=%s',
    async (withBanner) => {
      showBanner = withBanner

      await pruneGitWorktrees({ cwd: repo, wslDistro: 'Ubuntu' })

      expect(probeCount).toBe(1)
      expect(shellVersions).toEqual([gitVersion, gitVersion])
      expect(locksAtPrune).toEqual([PRUNE_GUARD_LOCK_REASON, userLock, ''])
      expect(pruneOutput).toContain('worktrees/stale-local')
      expect(pruneOutput).not.toContain('worktrees/foreign')
      expect(pruneOutput).not.toContain('worktrees/user-locked')
    }
  )
})
