import type * as ChildProcess from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GitRunner from './runner'

const { execFileMock, observeRunner, afterRunner } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  observeRunner: vi.fn(),
  afterRunner: vi.fn()
}))
vi.mock('node:child_process', async (importOriginal) => {
  const native = await importOriginal<typeof ChildProcess>()
  return {
    ...native,
    execFile: (...args: unknown[]) => execFileMock(native.execFile, ...args)
  }
})
vi.mock('./runner', async (importOriginal) => {
  const native = await importOriginal<typeof GitRunner>()
  return {
    ...native,
    gitExecFileAsync: async (...args: Parameters<typeof native.gitExecFileAsync>) => {
      observeRunner(...args)
      const result = await native.gitExecFileAsync(...args)
      await afterRunner(...args)
      return result
    }
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

import { readRepoLocation } from './worktree-list-reader'
import { describeCreatedWorktree, listWorktreesStrict } from './worktree-listing'
import { gitExecFileAsync } from './runner'
import { clearGitCapabilityStateForTests } from './git-capability-state'
import { disposeLocalRepoRefMaintenance } from './local-repo-ref-maintenance'
import { _resetGitAdmissionForTests } from './command-runner/git-subprocess-admission'

const names = [
  'ordinary',
  'line\nbreak',
  'blank\n\nline',
  'line\n-dash',
  'trailing\r',
  'trailing\n',
  '--path-format=absolute\nrepo',
  ' space '
]
const roles = ['main', 'metadata', 'linked'] as const
const cases = roles.flatMap((role) => names.map((name) => ({ role, name })))
type Fixture = {
  main: string
  common: string
  linked: string
  linkedGitDir: string
  head: string
}
const fixtures = new Map<string, Fixture>()
let root = ''
let gitBinary = ''

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runProcess({
    program: gitBinary,
    args: ['-c', 'core.hooksPath=', '-c', 'commit.gpgsign=false', ...args],
    cwd
  })
  expect(result.code, result.stderr).toBe(0)
  return result.stdout
}

function fixtureFor(role: string, name: string): Fixture {
  const fixture = fixtures.get(`${role}:${name}`)
  if (!fixture) {
    throw new Error('missing fixture')
  }
  return fixture
}

async function snapshot(fixture: Fixture) {
  return {
    refs: await git(fixture.main, 'for-each-ref', '--format=%(refname) %(objectname)'),
    bytes: await Promise.all(
      [
        join(fixture.common, 'HEAD'),
        join(fixture.common, 'index'),
        join(fixture.linkedGitDir, 'HEAD'),
        join(fixture.linkedGitDir, 'index'),
        join(fixture.main, '.git'),
        join(fixture.linked, '.git'),
        join(fixture.main, 'file.txt'),
        join(fixture.linked, 'file.txt')
      ].map((path) => readFile(path))
    )
  }
}

function calls(): string[][] {
  return observeRunner.mock.calls.map(([args]) => args)
}

describe.skipIf(process.platform === 'win32')('worktree location paths with real Git', () => {
  beforeAll(async () => {
    vi.stubEnv('ORCA_DISABLE_REPO_REF_MAINTENANCE', '1')
    const resolved = await runProcess({ program: '/bin/sh', args: ['-c', 'command -v git'] })
    gitBinary = process.env.ORCA_GIT_COMPAT_BINARY ?? resolved.stdout.trim()
    expect(isAbsolute(gitBinary)).toBe(true)
    execFileMock.mockImplementation(
      (native: typeof ChildProcess.execFile, command, args, options, callback) => {
        expect(command).toBe('git')
        return native(gitBinary, args, options, callback)
      }
    )
    root = await realpath(await mkdtemp(join(tmpdir(), 'orca-worktree-location-')))
    const seed = join(root, 'seed')
    await mkdir(seed)
    const version = (await git(seed, '--version')).trim()
    expect((await gitExecFileAsync(['--version'], { cwd: seed })).stdout.trim()).toBe(version)
    if (process.env.ORCA_GIT_COMPAT_VERSION) {
      expect(version).toBe(`git version ${process.env.ORCA_GIT_COMPAT_VERSION}`)
    }
    await git(seed, 'init', '-q')
    await git(seed, 'symbolic-ref', 'HEAD', 'refs/heads/main')
    await git(seed, 'config', 'user.name', 'Test')
    await git(seed, 'config', 'user.email', 'test@example.test')
    await writeFile(join(seed, 'file.txt'), 'preserved bytes\n')
    await git(seed, 'add', 'file.txt')
    await git(seed, 'commit', '-qm', 'seed')
    for (const [index, { role, name }] of cases.entries()) {
      const parent = join(root, String(index))
      await mkdir(parent)
      const main = join(parent, role === 'main' ? name : 'repo')
      const metadataParent = role === 'metadata' ? join(parent, name) : parent
      await mkdir(metadataParent, { recursive: true })
      const common = join(metadataParent, 'metadata')
      const linked = join(parent, role === 'linked' ? name : 'linked')
      await git(parent, 'clone', '-q', `--separate-git-dir=${common}`, seed, main)
      await git(main, 'worktree', 'add', '-qb', 'feature', linked)
      fixtures.set(`${role}:${name}`, {
        main,
        common,
        linked,
        linkedGitDir: (await git(linked, 'rev-parse', '--absolute-git-dir')).slice(0, -1),
        head: (await git(main, 'rev-parse', 'HEAD')).trim()
      })
    }
  })

  afterAll(async () => {
    await disposeLocalRepoRefMaintenance()
    vi.unstubAllEnvs()
    if (root) {
      await rm(root, { recursive: true, force: true })
    }
  })

  beforeEach(() => {
    clearGitCapabilityStateForTests()
    observeRunner.mockClear()
    execFileMock.mockClear()
    afterRunner.mockReset()
  })

  afterEach(() => {
    _resetGitAdmissionForTests()
  })

  it.each(cases)(
    'preserves location and created-row paths: $role, $name',
    async ({ role, name }) => {
      const fixture = fixtureFor(role, name)
      const before = await snapshot(fixture)
      for (const [cwd, gitDir] of [
        [fixture.main, fixture.common],
        [fixture.linked, fixture.linkedGitDir]
      ]) {
        observeRunner.mockClear()
        expect(await readRepoLocation(cwd, cwd)).toEqual({
          topLevel: cwd,
          commonDir: fixture.common,
          gitDir
        })
        const ambiguous = [cwd, fixture.common, gitDir].some((path) => path.includes('\n'))
        expect(calls()).toHaveLength(ambiguous ? 4 : 1)
        if (ambiguous) {
          expect(calls().slice(1)).toEqual([
            ['rev-parse', '--show-toplevel'],
            ['rev-parse', '--git-common-dir'],
            ['rev-parse', '--git-dir']
          ])
        }
      }
      expect(await describeCreatedWorktree(fixture.main, fixture.linked, 'feature')).toMatchObject({
        path: fixture.linked,
        head: fixture.head,
        branch: 'refs/heads/feature',
        isMainWorktree: false
      })
      expect(await snapshot(fixture)).toEqual(before)
    }
  )

  it.each(names)('lists the actual main folder %j', async (name) => {
    const fixture = fixtureFor('main', name)
    const before = await snapshot(fixture)
    const rows = await listWorktreesStrict(fixture.main)
    expect(rows.find((row) => row.isMainWorktree)?.path).toBe(fixture.main)
    expect(await snapshot(fixture)).toEqual(before)
  })

  it('stops individual reads when the first pathname command fails', async () => {
    const fixture = fixtureFor('main', 'line\nbreak')
    const marker = join(fixture.main, '.git')
    const backup = join(fixture.main, '.git.saved')
    let moved = false
    afterRunner.mockImplementation(async (args: string[]) => {
      if (args.includes('--show-toplevel') && args.includes('--git-common-dir')) {
        await rename(marker, backup)
        moved = true
      }
    })
    try {
      await expect(readRepoLocation(fixture.main, fixture.main)).resolves.toBeUndefined()
      expect(calls()).toHaveLength(2)
      expect(calls()[1]).toEqual(['rev-parse', '--show-toplevel'])
    } finally {
      if (moved) {
        await rename(backup, marker)
      }
    }
  })

  it('starts no later pathname reads after cancellation', async () => {
    const fixture = fixtureFor('main', 'line\nbreak')
    const controller = new AbortController()
    afterRunner.mockImplementation(async (args: string[]) => {
      if (args.length === 2 && args[1] === '--show-toplevel') {
        controller.abort(new Error('location request closed'))
      }
    })
    await expect(
      readRepoLocation(fixture.main, fixture.main, { signal: controller.signal, timeout: 5_000 })
    ).resolves.toBeUndefined()
    expect(calls()).toHaveLength(2)
    expect(calls()[1]).toEqual(['rev-parse', '--show-toplevel'])
  })

  it('starts no command for an already cancelled request', async () => {
    const fixture = fixtureFor('main', 'line\nbreak')
    const controller = new AbortController()
    controller.abort(new Error('already closed'))
    await expect(
      readRepoLocation(fixture.main, fixture.main, { signal: controller.signal })
    ).resolves.toBeUndefined()
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('starts no pathname fallback when the batched command fails', async () => {
    const plain = join(root, 'not-a-repo')
    await mkdir(plain)
    await expect(readRepoLocation(plain, plain)).resolves.toBeUndefined()
    expect(calls()).toHaveLength(1)
  })
})
