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
import { clearGitCapabilityStateForTests } from './git-capability-state'
import {
  finalizePreparedWorktree,
  prepareWorktreeCreateCheckout
} from './worktree-create-preparation'

const nativePlatform = process.platform
const routes = ['native', 'clean', 'newline', 'no-newline'] as const
const cases = routes.flatMap((route) =>
  (['no-barrier', 'barrier', 'finalize-equal', 'finalize-changed'] as const).map((workflow) => ({
    route,
    workflow
  }))
)
const reason = 'orca-create-preparation:v1:materialization:owned'
const base = 'refs/remotes/origin/main'
let binary: string
let fixture: string
let environment: NodeJS.ProcessEnv

function git(cwd: string, ...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    workerExecFile(
      binary,
      args,
      { cwd, env: environment, maxBuffer: 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(String(stdout)))
    )
  })
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

describe.skipIf(nativePlatform === 'win32')('preparation OIDs through generated WSL shells', () => {
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
    clearGitCapabilityStateForTests()
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
    clearGitCapabilityStateForTests()
    _resetGitAdmissionForTests()
    await rm(fixture, { recursive: true, force: true })
  })

  it.each(cases)('materializes actual tips, $route/$workflow', async ({ route, workflow }) => {
    const repo = join(fixture, 'repo')
    const prepared = join(fixture, 'prepared')
    const final = join(fixture, 'final')
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
    await git(repo, 'update-ref', base, initial)
    const hooks = join(fixture, 'hooks')
    await mkdir(hooks)
    await writeFile(join(hooks, 'post-checkout'), '#!/bin/sh\necho hook >> checkout-hook.txt\n', {
      mode: 0o755
    })
    await git(repo, 'config', 'core.hooksPath', hooks)
    const baseline = {
      head: await git(repo, 'rev-parse', 'HEAD'),
      mainRef: await git(repo, 'show-ref', '--verify', 'refs/heads/main'),
      status: await git(repo, 'status', '--porcelain=v2', '-z'),
      content: await readFile(join(repo, 'tracked.txt')),
      index: await readFile(join(repo, '.git', 'index'))
    }
    const registration = Promise.withResolvers<void>()
    const barrier = Promise.withResolvers<void>()
    const probeCodes: unknown[] = []
    const mutations: string[] = []
    execFileMock.mockImplementation((command, args, options, callback) => {
      let program = binary
      let argv = args
      let probe = false
      const nested = (value: string) => quotePosixShell(value).slice(1, -1)
      const hasArgument = (word: string): boolean =>
        command === 'git'
          ? args.includes(word)
          : String(args.at(-1)).includes(nested(quotePosixShell(word))) ||
            String(args.at(-1)).includes(quotePosixShell(word))
      const adding = hasArgument('worktree') && hasArgument('add')
      if (command === 'wsl.exe') {
        expect(args).toContain('--exec')
        const script = String(args.at(-1))
        probe = script.includes('_orca_git_path=')
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
      for (const word of ['reset', 'checkout', 'move']) {
        if (!probe && hasArgument(word)) {
          mutations.push(word)
        }
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
          if (adding && !error) {
            registration.resolve()
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
    const options = wsl ? { wslDistro: 'Ubuntu' } : {}
    const preparing = prepareWorktreeCreateCheckout(
      repo,
      prepared,
      base,
      reason,
      options,
      workflow === 'barrier' ? barrier.promise : undefined
    )
    if (workflow === 'barrier') {
      await registration.promise
      await git(repo, 'update-ref', base, fetched)
      barrier.resolve()
    }
    await preparing
    const preparedTarget = workflow === 'barrier' ? fetched : initial
    expect((await git(prepared, 'rev-parse', 'HEAD')).trim()).toBe(preparedTarget)
    expect(await readFile(join(prepared, 'tracked.txt'), 'utf8')).toBe(
      workflow === 'barrier' ? 'fetched\n' : 'initial\n'
    )
    const lock = (await git(prepared, 'rev-parse', '--git-path', 'locked')).trimEnd()
    expect(await readFile(lock, 'utf8')).toBe(`${reason}\n`)
    await expect(readFile(join(prepared, 'checkout-hook.txt'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
    expect(mutations).toEqual(['reset'])
    if (workflow.startsWith('finalize')) {
      mutations.length = 0
      if (workflow === 'finalize-changed') {
        await git(repo, 'update-ref', base, fetched)
      }
      const result = await finalizePreparedWorktree(
        repo,
        prepared,
        final,
        'feature',
        base,
        false,
        options,
        reason
      )
      expect(result.preparedHeadReset).toBe(workflow === 'finalize-changed')
      expect(mutations).toEqual(
        workflow === 'finalize-changed' ? ['reset', 'move', 'checkout'] : ['move', 'checkout']
      )
      expect((await git(final, 'rev-parse', 'HEAD')).trim()).toBe(
        workflow === 'finalize-changed' ? fetched : initial
      )
      expect(await readFile(join(final, 'tracked.txt'), 'utf8')).toBe(
        workflow === 'finalize-changed' ? 'fetched\n' : 'initial\n'
      )
      expect((await git(final, 'symbolic-ref', 'HEAD')).trim()).toBe('refs/heads/feature')
      expect((await git(final, 'config', '--get', 'branch.feature.base')).trim()).toBe(base)
      expect(await git(final, 'status', '--porcelain=v2', '-z')).toBe('? checkout-hook.txt\u0000')
      expect(await readFile(join(final, 'checkout-hook.txt'), 'utf8')).toBe('hook\n')
      await expect(readFile(lock)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(join(prepared, '.git'))).rejects.toMatchObject({ code: 'ENOENT' })
    }
    expect(probeCodes).toEqual(wsl ? [78] : [])
    Object.defineProperty(process, 'platform', { configurable: true, value: nativePlatform })
    expect({
      head: await git(repo, 'rev-parse', 'HEAD'),
      mainRef: await git(repo, 'show-ref', '--verify', 'refs/heads/main'),
      status: await git(repo, 'status', '--porcelain=v2', '-z'),
      content: await readFile(join(repo, 'tracked.txt')),
      index: await readFile(join(repo, '.git', 'index'))
    }).toEqual(baseline)
  })
})

installRealWorkerThreadChildProcesses()
