import type * as ChildProcess from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as WorkerChildModule from '../worker-thread-child-process/worker-thread-child-process'
import type { WorkerThreadChildProcessHost } from '../worker-thread-child-process/worker-thread-child-process'
import {
  createWorkerThreadChildProcessTestEntry,
  createWorkerThreadChildProcessTestHost
} from '../worker-thread-child-process/worker-thread-child-process-worker.test-fixtures'
import { quotePosixShell } from '../../shared/shell-argument-quoting'

const state = vi.hoisted(() => {
  const state: {
    execFile: ReturnType<typeof vi.fn>
    host: ReturnType<typeof createWorkerThreadChildProcessTestHost> | undefined
  } = { execFile: vi.fn(), host: undefined }
  return state
})
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof ChildProcess>()),
  execFile: state.execFile
}))
vi.mock('../worker-thread-child-process/worker-thread-child-process', async (original) => ({
  ...(await original<typeof WorkerChildModule>()),
  spawnProcessOnWorkerThread: (spec: Parameters<WorkerThreadChildProcessHost['spawn']>[0]) => {
    if (!state.host) {
      throw new Error('Test worker is not initialized')
    }
    return state.host.spawn(spec)
  }
}))
vi.mock('../observability/instrumentation', () => ({
  withGitSpan: (_attributes: unknown, run: () => unknown) => run()
}))
vi.mock('../diagnostics/main-thread-churn-probe', () => ({ recordSubprocessSpawn: vi.fn() }))

import { workerExecFile } from './command-runner/worker-exec-file'
import { _resetGitAdmissionForTests } from './command-runner/git-subprocess-admission'
import { resetWslGitReadEnvironmentForTests } from './wsl-git-read-environment'
import { gitSyncForkDefaultBranch } from './fork-sync'

const nativePlatform = process.platform
const routes = ['native', 'clean', 'newline', 'no-newline'] as const
const scenarios = routes.flatMap((route) =>
  (['equal', 'behind', 'diverged', 'mismatch'] as const).map((scenario) => ({ route, scenario }))
)
let fixture: string
let repo: string
let origin: string
let upstream: string
let binary: string
let initial: string
let advanced: string
let divergent: string
let environment: NodeJS.ProcessEnv
let disposeEntry: (() => Promise<void>) | undefined

function platform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value })
}

async function git(...args: string[]): Promise<string> {
  const result = await runProcess({ program: binary, args, cwd: repo, env: environment })
  expect(result.code, result.stderr).toBe(0)
  return result.stdout
}

describe.skipIf(nativePlatform === 'win32')('fork sync through generated WSL shells', () => {
  beforeAll(async () => {
    const resolved = await runProcess({ program: '/bin/sh', args: ['-c', 'command -v git'] })
    expect(resolved.code, resolved.stderr).toBe(0)
    binary = process.env.ORCA_GIT_COMPAT_BINARY ?? resolved.stdout.trim()
    expect(isAbsolute(binary)).toBe(true)
    const entry = await createWorkerThreadChildProcessTestEntry()
    disposeEntry = entry.dispose
    state.host = createWorkerThreadChildProcessTestHost(entry.entryPath)
    state.host.releaseOutput()
    fixture = await mkdtemp(join(tmpdir(), 'orca-fork-sync-'))
    repo = join(fixture, 'repo')
    origin = join(fixture, 'origin.git')
    upstream = join(fixture, 'upstream.git')
    await mkdir(repo)
    await writeFile(join(fixture, 'global'), '')
    const ssh = join(fixture, 'fixture-ssh')
    await writeFile(
      ssh,
      `#!/bin/sh
case "$*" in
  *git-upload-pack*team/orca.git*) exec ${quotePosixShell(binary)} upload-pack ${quotePosixShell(upstream)} ;;
  *git-upload-pack*fork/orca.git*) exec ${quotePosixShell(binary)} upload-pack ${quotePosixShell(origin)} ;;
  *git-receive-pack*fork/orca.git*) exec ${quotePosixShell(binary)} receive-pack ${quotePosixShell(origin)} ;;
  *) exit 91 ;;
esac
`
    )
    await chmod(ssh, 0o700)
    environment = {
      ...process.env,
      GIT_CONFIG_GLOBAL: join(fixture, 'global'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Audit',
      GIT_AUTHOR_EMAIL: 'audit@example.test',
      GIT_COMMITTER_NAME: 'Audit',
      GIT_COMMITTER_EMAIL: 'audit@example.test',
      GIT_SSH_COMMAND: quotePosixShell(ssh),
      GIT_SSH_VARIANT: 'ssh',
      GIT_TERMINAL_PROMPT: '0'
    }
    if (process.env.ORCA_GIT_COMPAT_VERSION) {
      expect((await git('--version')).trim()).toBe(
        `git version ${process.env.ORCA_GIT_COMPAT_VERSION}`
      )
    }
    await git('init', '-q')
    await git('checkout', '-qb', 'main')
    await writeFile(join(repo, 'file.txt'), 'initial\n')
    await git('add', 'file.txt')
    await git('commit', '-qm', 'initial')
    initial = (await git('rev-parse', 'HEAD')).trim()
    await writeFile(join(repo, 'file.txt'), 'upstream\n')
    await git('commit', '-qam', 'upstream')
    advanced = (await git('rev-parse', 'HEAD')).trim()
    await git('reset', '--hard', initial)
    await writeFile(join(repo, 'file.txt'), 'origin\n')
    await git('commit', '-qam', 'origin')
    divergent = (await git('rev-parse', 'HEAD')).trim()
    await git('reset', '--hard', initial)
    for (const bare of [origin, upstream]) {
      await git('init', '--bare', '-q', bare)
      await git('--git-dir', bare, 'symbolic-ref', 'HEAD', 'refs/heads/main')
    }
    await git('push', origin, `${initial}:refs/heads/main`, `${divergent}:refs/heads/audit-object`)
    await git('push', upstream, `${advanced}:refs/heads/main`)
    await git('remote', 'add', 'origin', 'git@github.com:fork/orca.git')
    await git('remote', 'add', 'upstream', 'git@github.com:team/orca.git')
  })

  afterAll(async () => {
    await state.host?.dispose()
    state.host = undefined
    await disposeEntry?.()
    if (fixture) {
      await rm(fixture, { recursive: true, force: true })
    }
  })

  beforeEach(() => {
    state.execFile.mockReset()
    resetWslGitReadEnvironmentForTests()
  })

  afterEach(() => {
    platform(nativePlatform)
    resetWslGitReadEnvironmentForTests()
    _resetGitAdmissionForTests()
  })

  it.each(scenarios)(
    'preserves safety, route=$route scenario=$scenario',
    async ({ route, scenario }) => {
      const originBefore = scenario === 'diverged' ? divergent : initial
      await git('--git-dir', origin, 'update-ref', 'refs/heads/main', originBefore)
      await git(
        '--git-dir',
        upstream,
        'update-ref',
        'refs/heads/main',
        scenario === 'equal' ? initial : advanced
      )
      const before = {
        head: await git('rev-parse', 'HEAD'),
        status: await git('status', '--porcelain=v2', '-z'),
        file: await readFile(join(repo, 'file.txt'), 'utf8'),
        upstream: await git('--git-dir', upstream, 'show-ref')
      }
      const commands: string[][] = []
      const probeExits: (number | null)[] = []
      state.execFile.mockImplementation((command, args, options, callback) => {
        let program = binary
        let commandArgs = args
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
          commandArgs = ['-c', `printf %s ${quotePosixShell(notice)}; ${routed}`]
        } else {
          expect(command).toBe('git')
          expect(route).toBe('native')
        }
        if (!probe) {
          commands.push(commandArgs)
        }
        const child = workerExecFile(
          program,
          commandArgs,
          {
            ...options,
            cwd: repo,
            env: { ...options.env, ...environment },
            maxBuffer: 1024 * 1024
          },
          callback
        )
        if (probe) {
          child.once('close', (code: number | null) => probeExits.push(code))
        }
        return child
      })
      const wsl = route !== 'native'
      platform(wsl ? 'win32' : nativePlatform)
      const result = await gitSyncForkDefaultBranch(
        repo,
        { owner: scenario === 'mismatch' ? 'other' : 'team', repo: 'orca' },
        wsl ? { wslDistro: 'Ubuntu' } : {}
      )
      expect(result).toMatchObject(
        scenario === 'mismatch'
          ? { status: 'blocked', reason: 'upstream-mismatch', ahead: 0, behind: 0 }
          : scenario === 'diverged'
            ? { status: 'blocked', reason: 'diverged', ahead: 1, behind: 1 }
            : scenario === 'equal'
              ? { status: 'up-to-date', ahead: 0, behind: 0 }
              : { status: 'synced', ahead: 0, behind: 1 }
      )
      if (scenario === 'mismatch') {
        expect(commands).toHaveLength(2)
      }
      expect(probeExits).toEqual(wsl ? [78] : [])
      platform(nativePlatform)
      expect((await git('--git-dir', origin, 'rev-parse', 'refs/heads/main')).trim()).toBe(
        scenario === 'behind' ? advanced : originBefore
      )
      expect({
        head: await git('rev-parse', 'HEAD'),
        status: await git('status', '--porcelain=v2', '-z'),
        file: await readFile(join(repo, 'file.txt'), 'utf8'),
        upstream: await git('--git-dir', upstream, 'show-ref')
      }).toEqual(before)
    }
  )
})
