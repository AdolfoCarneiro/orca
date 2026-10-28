import type * as ChildProcess from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as WorkerChildModule from '../../worker-thread-child-process/worker-thread-child-process'
import type { WorkerThreadChildProcessHost } from '../../worker-thread-child-process/worker-thread-child-process'
import {
  createWorkerThreadChildProcessTestEntry,
  createWorkerThreadChildProcessTestHost
} from '../../worker-thread-child-process/worker-thread-child-process-worker.test-fixtures'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import { buildCommitMessagePrompt } from '../../../shared/commit-message-generation'

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
vi.mock('../../worker-thread-child-process/worker-thread-child-process', async (original) => ({
  ...(await original<typeof WorkerChildModule>()),
  spawnProcessOnWorkerThread: (spec: Parameters<WorkerThreadChildProcessHost['spawn']>[0]) => {
    if (!state.host) {
      throw new Error('Test worker is not initialized')
    }
    return state.host.spawn(spec)
  }
}))
vi.mock('../../observability/instrumentation', () => ({
  withGitSpan: (_attributes: unknown, run: () => unknown) => run()
}))
vi.mock('../../diagnostics/main-thread-churn-probe', () => ({ recordSubprocessSpawn: vi.fn() }))

import { workerExecFile } from '../command-runner/worker-exec-file'
import { _resetGitAdmissionForTests } from '../command-runner/git-subprocess-admission'
import { resetWslGitReadEnvironmentForTests } from '../wsl-git-read-environment'
import { getStagedCommitContext } from './staged-commit-context'

const nativePlatform = process.platform
const routes = ['native', 'clean', 'newline', 'no-newline'] as const
const scenarios = routes.flatMap((route) => [
  { route, staged: false },
  { route, staged: true }
])
let fixture: string
let repo: string
let binary: string
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

describe.skipIf(nativePlatform === 'win32')('staged context through generated WSL shells', () => {
  beforeAll(async () => {
    const resolved = await runProcess({ program: '/bin/sh', args: ['-c', 'command -v git'] })
    expect(resolved.code, resolved.stderr).toBe(0)
    binary = process.env.ORCA_GIT_COMPAT_BINARY ?? resolved.stdout.trim()
    expect(isAbsolute(binary)).toBe(true)
    const entry = await createWorkerThreadChildProcessTestEntry()
    disposeEntry = entry.dispose
    state.host = createWorkerThreadChildProcessTestHost(entry.entryPath)
    state.host.releaseOutput()
    fixture = await mkdtemp(join(tmpdir(), 'orca-staged-context-'))
    repo = join(fixture, 'repo')
    await mkdir(repo)
    await writeFile(join(fixture, 'global'), '')
    environment = {
      ...process.env,
      GIT_CONFIG_GLOBAL: join(fixture, 'global'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Audit',
      GIT_AUTHOR_EMAIL: 'audit@example.test',
      GIT_COMMITTER_NAME: 'Audit',
      GIT_COMMITTER_EMAIL: 'audit@example.test'
    }
    if (process.env.ORCA_GIT_COMPAT_VERSION) {
      expect((await git('--version')).trim()).toBe(
        `git version ${process.env.ORCA_GIT_COMPAT_VERSION}`
      )
    }
    await git('init', '-q')
    await git('checkout', '-qb', 'topic')
    await writeFile(join(repo, 'file.txt'), 'before\n')
    await git('add', 'file.txt')
    await git('commit', '-qm', 'initial')
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
    'preserves context, route=$route staged=$staged',
    async ({ route, staged }) => {
      await writeFile(join(repo, 'file.txt'), staged ? 'after\n' : 'before\n')
      await git('add', 'file.txt')
      const before = {
        head: await git('rev-parse', 'HEAD'),
        status: await git('status', '--porcelain=v2', '-z'),
        file: await readFile(join(repo, 'file.txt'), 'utf8')
      }
      const summary = await git('diff', '--cached', '--name-status')
      const patch = await git(
        'diff',
        '--cached',
        '--patch',
        '--minimal',
        '--no-color',
        '--no-ext-diff'
      )
      let reads = 0
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
          reads++
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
      const context = await getStagedCommitContext(repo, wsl ? { wslDistro: 'Ubuntu' } : {})
      expect(context).toEqual(
        staged ? { branch: 'topic', stagedSummary: summary.trim(), stagedPatch: patch } : null
      )
      if (context) {
        expect(buildCommitMessagePrompt(context, '')).not.toContain('LOGIN_NOTICE:')
      }
      expect(reads).toBe(staged ? 3 : 2)
      expect(probeExits).toEqual(wsl ? [78] : [])
      platform(nativePlatform)
      expect({
        head: await git('rev-parse', 'HEAD'),
        status: await git('status', '--porcelain=v2', '-z'),
        file: await readFile(join(repo, 'file.txt'), 'utf8')
      }).toEqual(before)
    }
  )
})
