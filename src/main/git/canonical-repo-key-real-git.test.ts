import type * as ChildProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GitRunner from './runner'

const { execFileMock, observeRunner } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  observeRunner: vi.fn()
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
    gitExecFileAsync: (...args: Parameters<typeof native.gitExecFileAsync>) => {
      observeRunner(...args)
      return native.gitExecFileAsync(...args)
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

import { getCanonicalRepoKey, _resetCanonicalRepoKeyCacheForTests } from './canonical-repo-key'
import { gitExecFileAsync } from './runner'
import { RuntimeRemoteFetchController } from '../runtime/runtime-remote-fetch-controller'
import { disposeLocalRepoRefMaintenance } from './local-repo-ref-maintenance'
import { _resetGitAdmissionForTests } from './command-runner/git-subprocess-admission'
import { resetWslGitReadEnvironmentForTests } from './wsl-git-read-environment'
import { quotePosixShell } from '../../shared/shell-argument-quoting'
import { readRepoCommonDirFromGit } from './worktree-list-reader'
import { clearGitCapabilityStateForTests } from './git-capability-state'

const nativePlatform = process.platform
const modes = ['native', 'clean', 'banner'] as const
const banner = 'To run a command as administrator, use sudo.\n\n'
const names = [
  'ordinary',
  'line\nbreak',
  'trailing\r',
  'trailing\n',
  '--path-format=absolute\nrepo',
  ' space '
]
let root: string
let gitBinary: string
let version: string
const fixtures = new Map<string, { common: string; linked: string; index: Buffer }>()

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runProcess({ program: gitBinary, args, cwd })
  expect(result.code, result.stderr).toBe(0)
  return result.stdout
}

function fetchCallCount(): number {
  return observeRunner.mock.calls.filter(([args]) => args.includes('fetch')).length
}

describe.skipIf(nativePlatform === 'win32')('common-directory identity with real Git', () => {
  beforeAll(async () => {
    vi.stubEnv('ORCA_DISABLE_REPO_REF_MAINTENANCE', '1')
    const resolved = await runProcess({ program: '/bin/sh', args: ['-c', 'command -v git'] })
    gitBinary = process.env.ORCA_GIT_COMPAT_BINARY ?? resolved.stdout.trim()
    expect(isAbsolute(gitBinary)).toBe(true)
    root = await mkdtemp(join(tmpdir(), 'orca-common-dir-'))
    const seed = join(root, 'seed')
    await mkdir(seed)
    version = (await git(seed, '--version')).trim()
    if (process.env.ORCA_GIT_COMPAT_VERSION) {
      expect(version).toBe(`git version ${process.env.ORCA_GIT_COMPAT_VERSION}`)
    }
    await git(seed, 'init', '-q')
    await git(seed, 'config', 'user.name', 'Test')
    await git(seed, 'config', 'user.email', 'test@example.test')
    await git(seed, 'config', 'commit.gpgsign', 'false')
    await git(seed, 'config', 'core.hooksPath', '')
    await writeFile(join(seed, 'file.txt'), 'fixture bytes\n')
    await git(seed, 'add', 'file.txt')
    await git(seed, 'commit', '-qm', 'fixture')
    await git(seed, 'branch', '-M', 'main')
    for (const [index, name] of names.entries()) {
      const parent = join(root, String(index))
      await mkdir(parent)
      const common = join(parent, name)
      const linked = join(parent, 'linked')
      await git(parent, 'clone', '--bare', '-q', seed, common)
      await git(common, 'worktree', 'add', '--detach', '-q', linked, 'main')
      fixtures.set(name, {
        common,
        linked,
        index: await readFile(join(common, 'worktrees/linked/index'))
      })
    }
  })

  afterAll(async () => {
    await disposeLocalRepoRefMaintenance()
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  })

  beforeEach(() => {
    observeRunner.mockClear()
    _resetCanonicalRepoKeyCacheForTests()
    clearGitCapabilityStateForTests()
    resetWslGitReadEnvironmentForTests()
    execFileMock.mockImplementation(
      (nativeExec: typeof ChildProcess.execFile, command, args, options, callback) => {
        expect(command).toBe('git')
        return nativeExec(gitBinary, args, options, callback)
      }
    )
  })

  afterEach(async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: nativePlatform })
    resetWslGitReadEnvironmentForTests()
    _resetGitAdmissionForTests()
    for (const { common, linked, index } of fixtures.values()) {
      expect(await readFile(join(common, 'worktrees/linked/index'))).toEqual(index)
      expect(await readFile(join(linked, 'file.txt'), 'utf8')).toBe('fixture bytes\n')
    }
  })

  it.each(names.flatMap((name) => modes.map((mode) => ({ name, mode }))))(
    'preserves the complete common directory $name, mode=$mode',
    async ({ name, mode }) => {
      const fixture = fixtures.get(name)
      if (!fixture) {
        throw new Error('missing fixture')
      }
      let rejectedProbes = 0
      let shellReads = 0
      if (mode !== 'native') {
        Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
        execFileMock.mockImplementation(
          (nativeExec: typeof ChildProcess.execFile, command, args, execOptions, callback) => {
            expect(command).toBe('wsl.exe')
            const script = String(args.at(-1))
            if (script.includes('_orca_git_path=')) {
              rejectedProbes += 1
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
            expect(args).toContain('--exec')
            const nestedGit = quotePosixShell(quotePosixShell('git')).slice(1, -1)
            const nestedBinary = quotePosixShell(quotePosixShell(gitBinary)).slice(1, -1)
            const routed = script.replaceAll(nestedGit, nestedBinary)
            expect(routed).not.toBe(script)
            const prefix = mode === 'banner' ? `printf %s ${quotePosixShell(banner)}; ` : ''
            shellReads += 1
            return nativeExec(
              '/bin/sh',
              ['-c', prefix + routed],
              { ...execOptions, cwd: root },
              callback
            )
          }
        )
      }
      const options = mode === 'native' ? {} : { wslDistro: 'Ubuntu' }
      const executed = await gitExecFileAsync(['--version'], {
        cwd: fixture.common,
        ...options,
        captureWslLoginShellOutput: true
      })
      expect(executed.stdout.trim()).toBe(version)
      const host = mode === 'native' ? 'local' : 'wsl:Ubuntu'
      expect(await getCanonicalRepoKey(fixture.common, options)).toBe(`${host}::${fixture.common}`)
      expect(await getCanonicalRepoKey(fixture.linked, options)).toBe(`${host}::${fixture.common}`)
      expect(await readRepoCommonDirFromGit(fixture.common, options)).toBe(fixture.common)
      expect(await readRepoCommonDirFromGit(fixture.linked, options)).toBe(fixture.common)
      if (mode !== 'native') {
        expect(rejectedProbes).toBe(1)
        expect(shellReads).toBe(5)
      }
    }
  )

  it.each(['ordinary', 'line\nbreak'])(
    'shares in-flight and fresh fetches for %j',
    async (name) => {
      const fixture = fixtures.get(name)
      if (!fixture) {
        throw new Error('missing fixture')
      }
      let release: (() => void) | undefined
      let notifyReady: (() => void) | undefined
      const ready = new Promise<void>((resolve) => {
        notifyReady = resolve
      })
      let fetches = 0
      execFileMock.mockImplementation(
        (nativeExec: typeof ChildProcess.execFile, command, args, options, callback) => {
          expect(command).toBe('git')
          const hold = args.includes('fetch') && fetches++ === 0
          return nativeExec(gitBinary, args, options, (error, stdout, stderr) => {
            if (hold) {
              release = () => callback(error, stdout, stderr)
              notifyReady?.()
            } else {
              callback(error, stdout, stderr)
            }
          })
        }
      )
      const controller = new RuntimeRemoteFetchController()
      await controller.getCanonicalFetchKey(fixture.common, 'origin')
      await controller.getCanonicalFetchKey(fixture.linked, 'origin')
      const first = controller.getOrStartRemoteFetch(fixture.common, 'origin')
      await ready
      const second = controller.getOrStartRemoteFetch(fixture.linked, 'origin')
      for (let tick = 0; tick < 4; tick++) {
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
      const pendingCalls = fetchCallCount()
      release?.()
      expect(await Promise.all([first, second])).toEqual([{ ok: true }, { ok: true }])
      await expect(controller.getOrStartRemoteFetch(fixture.linked, 'origin')).resolves.toEqual({
        ok: true
      })
      expect(pendingCalls).toBe(1)
      expect(fetchCallCount()).toBe(1)
      expect(fetches).toBe(1)
    }
  )
})
