import type * as ChildProcess from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { quotePosixShell } from '../../shared/shell-argument-quoting'
import { installRealWorkerThreadChildProcesses } from '../worker-thread-child-process/worker-thread-child-process-real.test-fixtures'

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcess>()),
  execFile: execFileMock
}))
vi.mock('../observability/instrumentation', () => ({
  withGitSpan: (_attributes: unknown, run: () => unknown) => run()
}))
vi.mock('../diagnostics/main-thread-churn-probe', () => ({ recordSubprocessSpawn: vi.fn() }))

import { workerExecFile } from './command-runner/worker-exec-file'
import { _resetGitAdmissionForTests } from './command-runner/git-subprocess-admission'
import { resetWslGitReadEnvironmentForTests } from './wsl-git-read-environment'
import { measureRetargetDivergence } from './worktree-base-divergence'

const nativePlatform = process.platform
const notices = {
  native: '',
  clean: '',
  newline: 'Login notice\n',
  'no-newline': 'Login notice:',
  'digit-newline': '0 updates available\n',
  'digit-no-newline': '0 updates available:'
}
const graphs = [
  { target: 'within', expected: 'within' },
  { target: 'exceeded', expected: 'exceeded' }
] as const
const cases = graphs.flatMap((graph) =>
  Object.entries(notices).map(([route, notice]) => ({ ...graph, route, notice }))
)
let binary: string
let fixture: string
let environment: NodeJS.ProcessEnv
let protectedFiles: { path: string; bytes: Buffer }[]
let refsBefore: string

async function git(...args: string[]): Promise<string> {
  const result = await runProcess({ program: binary, args, cwd: fixture, env: environment })
  expect(result.code, result.stderr).toBe(0)
  return result.stdout
}

describe.skipIf(nativePlatform === 'win32')(
  'retarget divergence through generated WSL shells',
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
      fixture = await realpath(await mkdtemp(join(tmpdir(), 'orca-divergence-login-')))
      environment = {
        ...process.env,
        GIT_CONFIG_GLOBAL: join(fixture, '.git', 'global'),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.test',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.test'
      }
      await git('init', '-q')
      await writeFile(join(fixture, '.git', 'global'), '')
      await git('symbolic-ref', 'HEAD', 'refs/heads/main')
      await git('config', 'gc.auto', '0')
      await git('config', 'maintenance.auto', 'false')
      await git('config', 'commit.gpgsign', 'false')
      await git('config', 'core.hooksPath', '')
      await writeFile(join(fixture, 'tracked.txt'), 'preserved\n')
      await git('add', '.')
      await git('commit', '-qm', 'base')
      const tree = (await git('rev-parse', 'HEAD^{tree}')).trim()
      let tip = (await git('rev-parse', 'HEAD')).trim()
      let within = tip
      for (let index = 1; index <= 101; index++) {
        tip = (await git('commit-tree', tree, '-p', tip, '-m', `commit-${index}`)).trim()
        if (index === 5) {
          within = tip
        }
      }
      await git('update-ref', 'refs/heads/within', within)
      await git('update-ref', 'refs/heads/exceeded', tip)
      refsBefore = await git('show-ref')
      protectedFiles = await Promise.all(
        ['.git/HEAD', '.git/index', '.git/config', 'tracked.txt'].map(async (path) => ({
          path: join(fixture, path),
          bytes: await readFile(join(fixture, path))
        }))
      )
    }, 30_000)

    beforeEach(() => {
      execFileMock.mockReset()
      resetWslGitReadEnvironmentForTests()
    })

    afterEach(async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: nativePlatform })
      resetWslGitReadEnvironmentForTests()
      _resetGitAdmissionForTests()
      expect(await git('show-ref')).toBe(refsBefore)
      for (const file of protectedFiles) {
        expect(await readFile(file.path)).toEqual(file.bytes)
      }
    })

    afterAll(async () => {
      await rm(fixture, { recursive: true, force: true })
    })

    it.each(cases)(
      'retains the divergence decision for $target/$route',
      async ({ target, expected, route, notice }) => {
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
            }
            program = '/bin/sh'
            argv = ['-c', `printf %s ${quotePosixShell(notice)}; ${routed}`]
          } else {
            expect(command).toBe('git')
            expect(route).toBe('native')
          }
          return workerExecFile(
            program,
            argv,
            { ...options, cwd: fixture, env: { ...options.env, ...environment } },
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
        expect(
          await measureRetargetDivergence(
            fixture,
            'refs/heads/main',
            `refs/heads/${target}`,
            wsl ? { wslDistro: 'Ubuntu' } : {}
          )
        ).toBe(expected)
        expect(probeCodes).toEqual(wsl ? [78] : [])
      }
    )
  }
)

installRealWorkerThreadChildProcesses()
