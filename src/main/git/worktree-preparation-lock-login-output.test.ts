import type * as ChildProcess from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { quotePosixShell } from '../../shared/shell-argument-quoting'
import { stripWin32LongPathPrefix } from '../../shared/windows-path-access'
import { installRealWorkerThreadChildProcesses } from '../worker-thread-child-process/worker-thread-child-process-real.test-fixtures'
import type * as HostTreeRemoval from '../host-tree-removal'

const { execFileMock, hostPathMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  hostPathMock: vi.fn()
}))
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcess>()),
  execFile: execFileMock
}))
vi.mock('../host-tree-removal', async (importOriginal) => ({
  ...(await importOriginal<typeof HostTreeRemoval>()),
  toHostFilesystemPath: hostPathMock
}))
vi.mock('../observability/instrumentation', () => ({
  withGitSpan: (_attributes: unknown, run: () => unknown) => run()
}))
vi.mock('../diagnostics/main-thread-churn-probe', () => ({ recordSubprocessSpawn: vi.fn() }))

import { workerExecFile } from './command-runner/worker-exec-file'
import { _resetGitAdmissionForTests } from './command-runner/git-subprocess-admission'
import { resetWslGitReadEnvironmentForTests } from './wsl-git-read-environment'
import {
  lockWorktreePreparation,
  unlockWorktreePreparation,
  verifyWorktreePreparationLock,
  WorktreePreparationLockOwnershipError
} from './worktree-preparation-lock'

const nativePlatform = process.platform
const routes = ['native', 'clean', 'newline', 'no-newline'] as const
const cases = ['ordinary', 'line\nbreak'].flatMap((name) =>
  routes.map((route) => ({ name, route }))
)
const reason = 'orca-create-preparation:v1:audit:owned'
const competingReason = 'manual user lock\n'
let binary: string
let fixture: string
let repo: string
let prepared: string
let environment: NodeJS.ProcessEnv

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runProcess({ program: binary, args, cwd, env: environment })
  expect(result.code, result.stderr).toBe(0)
  return result.stdout
}

function fixturePath(target: string): string {
  const value = stripWin32LongPathPrefix(target)
  const prefix = '\\\\wsl.localhost\\Ubuntu'
  const mapped = value.startsWith(prefix) ? value.slice(prefix.length).replaceAll('\\', '/') : value
  if (!mapped.startsWith(`${fixture}/`)) {
    throw new Error('Fixture path must stay in its owned directory')
  }
  return mapped
}

describe.skipIf(nativePlatform === 'win32')(
  'preparation locks through generated WSL shells',
  () => {
    beforeAll(async () => {
      const resolved = await runProcess({ program: '/bin/sh', args: ['-c', 'command -v git'] })
      expect(resolved.code, resolved.stderr).toBe(0)
      binary = process.env.ORCA_GIT_COMPAT_BINARY ?? resolved.stdout.trim()
      expect(isAbsolute(binary)).toBe(true)
      if (process.env.ORCA_GIT_COMPAT_VERSION) {
        const version = await runProcess({ program: binary, args: ['--version'] })
        expect(version.stdout.trim()).toBe(`git version ${process.env.ORCA_GIT_COMPAT_VERSION}`)
      }
    })

    beforeEach(async () => {
      execFileMock.mockReset()
      hostPathMock.mockReset().mockImplementation(fixturePath)
      resetWslGitReadEnvironmentForTests()
      fixture = await realpath(await mkdtemp(join(tmpdir(), 'orca-preparation-login-')))
      await writeFile(join(fixture, 'global'), '')
      environment = {
        ...process.env,
        GIT_CONFIG_GLOBAL: join(fixture, 'global'),
        GIT_CONFIG_NOSYSTEM: '1'
      }
    })

    afterEach(async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: nativePlatform })
      resetWslGitReadEnvironmentForTests()
      _resetGitAdmissionForTests()
      await rm(fixture, { recursive: true, force: true })
    })

    it.each(cases)('preserves the exact lock and owner, $name/$route', async ({ name, route }) => {
      repo = join(fixture, `repo-${name}`)
      prepared = join(fixture, 'prepared')
      await mkdir(repo)
      await git(repo, 'init', '-q')
      await git(repo, 'config', 'user.name', 'Test')
      await git(repo, 'config', 'user.email', 'test@example.test')
      await git(repo, 'config', 'commit.gpgsign', 'false')
      await git(repo, 'config', 'core.hooksPath', '')
      await writeFile(join(repo, 'tracked.txt'), 'preserved working bytes\n')
      await git(repo, 'add', '.')
      await git(repo, 'commit', '-qm', 'fixture')
      await git(repo, 'worktree', 'add', '--detach', '-q', prepared, 'HEAD')
      const lock = (await git(prepared, 'rev-parse', '--git-path', 'locked')).trimEnd()
      const indexBefore = await readFile(join(repo, '.git', 'worktrees', 'prepared', 'index'))
      const markerBefore = await readFile(join(prepared, '.git'))
      const probeCodes: unknown[] = []
      execFileMock.mockImplementation((command, args, options, callback) => {
        let program = binary
        let argv = args
        let probe = false
        if (command === 'wsl.exe') {
          expect(args).toContain('--exec')
          const script = String(args.at(-1))
          probe = script.includes('_orca_git_path=')
          const nested = (value: string) => quotePosixShell(value).slice(1, -1)
          const routed = probe
            ? script
            : script.replaceAll(nested("'git' "), nested(`${quotePosixShell(binary)} `))
          if (!probe) {
            expect(routed).not.toBe(script)
            expect(script).toContain(nested("'rev-parse'"))
          }
          const notice =
            route === 'newline' ? 'LOGIN_NOTICE:\n' : route === 'no-newline' ? 'LOGIN_NOTICE:' : ''
          program = '/bin/sh'
          argv = ['-c', `printf %s ${quotePosixShell(notice)}; ${routed}`]
        } else {
          expect(command).toBe('git')
          expect(route).toBe('native')
        }
        return workerExecFile(
          program,
          argv,
          {
            ...options,
            cwd: command === 'git' ? options.cwd : fixture,
            env: { ...options.env, ...environment }
          },
          (error, stdout, stderr) => {
            if (probe) {
              probeCodes.push(error && 'code' in error ? error.code : 0)
            }
            callback(error, stdout, stderr)
          }
        )
      })
      const wsl = route !== 'native'
      const options = wsl ? { wslDistro: 'Ubuntu' } : {}
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: wsl ? 'win32' : nativePlatform
      })
      expect(await lockWorktreePreparation(prepared, reason, options)).toBe(lock)
      const owned = await stat(lock)
      expect(await verifyWorktreePreparationLock(prepared, reason, options)).toBe(lock)
      expect(await readFile(lock, 'utf8')).toBe(`${reason}\n`)
      expect((await stat(lock)).ino).toBe(owned.ino)
      await writeFile(lock, competingReason)
      await expect(unlockWorktreePreparation(prepared, reason, options)).rejects.toBeInstanceOf(
        WorktreePreparationLockOwnershipError
      )
      await expect(lockWorktreePreparation(prepared, reason, options)).rejects.toBeInstanceOf(
        WorktreePreparationLockOwnershipError
      )
      expect(await readFile(lock, 'utf8')).toBe(competingReason)
      expect((await stat(lock)).ino).toBe(owned.ino)
      await writeFile(lock, `${reason}\n`)
      await unlockWorktreePreparation(prepared, reason, options)
      await expect(stat(lock)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(probeCodes).toEqual(wsl ? [78] : [])
      expect(await readFile(join(repo, '.git', 'worktrees', 'prepared', 'index'))).toEqual(
        indexBefore
      )
      expect(await readFile(join(prepared, '.git'))).toEqual(markerBefore)
      expect(await readFile(join(prepared, 'tracked.txt'), 'utf8')).toBe(
        'preserved working bytes\n'
      )
    })
  }
)

installRealWorkerThreadChildProcesses()
