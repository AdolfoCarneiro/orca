import type * as ChildProcess from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
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
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof ChildProcess>()),
  execFile: execFileMock
}))
vi.mock('../host-tree-removal', async (original) => ({
  ...(await original<typeof HostTreeRemoval>()),
  toHostFilesystemPath: hostPathMock
}))
vi.mock('../observability/instrumentation', () => ({
  withGitSpan: (_attributes: unknown, run: () => unknown) => run()
}))
vi.mock('../diagnostics/main-thread-churn-probe', () => ({ recordSubprocessSpawn: vi.fn() }))

import { workerExecFile } from './command-runner/worker-exec-file'
import { _resetGitAdmissionForTests } from './command-runner/git-subprocess-admission'
import { resetWslGitReadEnvironmentForTests } from './wsl-git-read-environment'
import { WorktreePreparationLockOwnershipError } from './worktree-preparation-lock'
import { refreshPreparedWorktreeTip } from './worktree-preparation-tip-refresh'

const nativePlatform = process.platform
const routes = ['native', 'clean', 'newline', 'no-newline'] as const
const cases = routes.flatMap((route) =>
  (['equal', 'changed', 'competing'] as const).map((scenario) => ({ route, scenario }))
)
const reason = 'orca-create-preparation:v1:tip:owned'
const base = 'refs/remotes/origin/main'
let binary: string
let fixture: string
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

describe.skipIf(nativePlatform === 'win32')('prepared tips through generated WSL shells', () => {
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
    fixture = await realpath(await mkdtemp(join(tmpdir(), 'orca-tip-login-')))
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

  it.each(cases)(
    'preserves the fetched tip and ownership, $route/$scenario',
    async ({ route, scenario }) => {
      const repo = join(fixture, 'repo')
      const prepared = join(fixture, 'prepared')
      await mkdir(repo)
      await git(repo, 'init', '-q')
      await git(repo, 'symbolic-ref', 'HEAD', 'refs/heads/main')
      await git(repo, 'config', 'user.name', 'Test')
      await git(repo, 'config', 'user.email', 'test@example.test')
      await git(repo, 'config', 'commit.gpgsign', 'false')
      await git(repo, 'config', 'core.hooksPath', '')
      await writeFile(join(repo, 'tracked.txt'), 'initial\n')
      await git(repo, 'add', 'tracked.txt')
      await git(repo, 'commit', '-qm', 'initial')
      const initial = (await git(repo, 'rev-parse', 'HEAD')).trim()
      await writeFile(join(repo, 'tracked.txt'), 'fetched\n')
      await git(repo, 'commit', '-qam', 'fetched')
      const fetched = (await git(repo, 'rev-parse', 'HEAD')).trim()
      await git(repo, 'reset', '--hard', initial)
      const target = scenario === 'equal' ? initial : fetched
      await git(repo, 'update-ref', base, target)
      await git(repo, 'worktree', 'add', '--detach', '-q', prepared, initial)
      const lock = (await git(prepared, 'rev-parse', '--git-path', 'locked')).trimEnd()
      const marker = scenario === 'competing' ? 'manual owner\n' : `${reason}\n`
      await writeFile(lock, marker)
      const hooks = join(fixture, 'hooks')
      await mkdir(hooks)
      await writeFile(join(hooks, 'post-checkout'), '#!/bin/sh\necho hook >> checkout-hook.txt\n', {
        mode: 0o755
      })
      await git(repo, 'config', 'core.hooksPath', hooks)
      const before = {
        head: await git(repo, 'rev-parse', 'HEAD'),
        refs: await git(repo, 'show-ref'),
        status: await git(repo, 'status', '--porcelain=v2', '-z'),
        content: await readFile(join(repo, 'tracked.txt')),
        marker: await readFile(lock),
        gitLink: await readFile(join(prepared, '.git'))
      }
      const indexBefore = await readFile(join(repo, '.git', 'worktrees', 'prepared', 'index'))
      const probeCodes: unknown[] = []
      let commands = 0
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
          }
          const notice =
            route === 'newline' ? 'LOGIN_NOTICE:\n' : route === 'no-newline' ? 'LOGIN_NOTICE:' : ''
          program = '/bin/sh'
          argv = ['-c', `printf %s ${quotePosixShell(notice)}; ${routed}`]
        } else {
          expect(command).toBe('git')
          expect(route).toBe('native')
        }
        if (!probe) {
          commands++
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
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: wsl ? 'win32' : nativePlatform
      })
      const refresh = refreshPreparedWorktreeTip(
        repo,
        prepared,
        base,
        reason,
        wsl ? { wslDistro: 'Ubuntu' } : {}
      )
      await (scenario === 'competing'
        ? expect(refresh).rejects.toBeInstanceOf(WorktreePreparationLockOwnershipError)
        : refresh)
      expect(commands).toBe(scenario === 'competing' ? 1 : scenario === 'equal' ? 3 : 4)
      expect(probeCodes).toEqual(wsl ? [78] : [])
      Object.defineProperty(process, 'platform', { configurable: true, value: nativePlatform })
      expect((await git(prepared, 'rev-parse', 'HEAD')).trim()).toBe(
        scenario === 'competing' ? initial : target
      )
      expect(await readFile(join(prepared, 'tracked.txt'), 'utf8')).toBe(
        scenario === 'changed' ? 'fetched\n' : 'initial\n'
      )
      expect(await git(prepared, 'status', '--porcelain=v2', '-z')).toBe('')
      await expect(readFile(join(prepared, 'checkout-hook.txt'))).rejects.toMatchObject({
        code: 'ENOENT'
      })
      expect({
        head: await git(repo, 'rev-parse', 'HEAD'),
        refs: await git(repo, 'show-ref'),
        status: await git(repo, 'status', '--porcelain=v2', '-z'),
        content: await readFile(join(repo, 'tracked.txt')),
        marker: await readFile(lock),
        gitLink: await readFile(join(prepared, '.git'))
      }).toEqual(before)
      if (scenario !== 'changed') {
        expect(await readFile(join(repo, '.git', 'worktrees', 'prepared', 'index'))).toEqual(
          indexBefore
        )
      }
    }
  )
})

installRealWorkerThreadChildProcesses()
