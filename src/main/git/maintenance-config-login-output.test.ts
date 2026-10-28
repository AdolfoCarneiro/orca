import type * as ChildProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { PassThrough } from 'node:stream'
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

import { createLocalRepoRefMaintenanceTarget } from './local-repo-ref-maintenance'
import {
  clearRepoPackIndexMaintenanceCache,
  maintainRepoPackIndex
} from './repo-pack-index-maintenance'
import { _resetGitAdmissionForTests } from './command-runner/git-subprocess-admission'
import { resetWslGitReadEnvironmentForTests } from './wsl-git-read-environment'
import {
  _resetWslBackgroundDistroGateForTests,
  noteWslDistrosRunning
} from '../wsl-background-distro-gate'
import {
  _resetRunningWslDistroCacheForTests,
  resolveRunningWslDistros
} from '../wsl-running-distro-cache'

const nativePlatform = process.platform
const routes = ['native', 'clean', 'newline', 'no-newline'] as const
let fixture: string
let repo: string
let binary: string
let environment: NodeJS.ProcessEnv
let originalConfig: Buffer
let probeExits: (number | null)[]
let configReads: number

function platform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value })
}

async function git(...args: string[]): Promise<string> {
  const result = await runProcess({ program: binary, args, cwd: repo, env: environment })
  expect(result.code, result.stderr).toBe(0)
  return result.stdout
}

describe.skipIf(nativePlatform === 'win32')(
  'maintenance config through generated WSL shells',
  () => {
    beforeAll(async () => {
      const resolved = await runProcess({ program: '/bin/sh', args: ['-c', 'command -v git'] })
      expect(resolved.code, resolved.stderr).toBe(0)
      binary = process.env.ORCA_GIT_COMPAT_BINARY ?? resolved.stdout.trim()
      expect(isAbsolute(binary)).toBe(true)
      fixture = await mkdtemp(join(tmpdir(), 'orca-maintenance-config-'))
      repo = join(fixture, 'repo')
      await mkdir(repo)
      await writeFile(join(fixture, 'global'), '')
      environment = {
        ...process.env,
        GIT_CONFIG_GLOBAL: join(fixture, 'global'),
        GIT_CONFIG_NOSYSTEM: '1'
      }
      if (process.env.ORCA_GIT_COMPAT_VERSION) {
        expect((await git('--version')).trim()).toBe(
          `git version ${process.env.ORCA_GIT_COMPAT_VERSION}`
        )
      }
      await git('init', '-q')
      originalConfig = await readFile(join(repo, '.git', 'config'))
    })

    afterAll(async () => {
      if (fixture) {
        await rm(fixture, { recursive: true, force: true })
      }
    })

    beforeEach(() => {
      execFileMock.mockReset()
      resetWslGitReadEnvironmentForTests()
      clearRepoPackIndexMaintenanceCache()
      _resetWslBackgroundDistroGateForTests()
      _resetRunningWslDistroCacheForTests()
      probeExits = []
      configReads = 0
    })

    afterEach(async () => {
      platform(nativePlatform)
      resetWslGitReadEnvironmentForTests()
      _resetWslBackgroundDistroGateForTests()
      _resetRunningWslDistroCacheForTests()
      _resetGitAdmissionForTests()
      expect(await readdir(join(repo, '.git', 'objects', 'pack'))).toEqual([])
    })

    it.each(routes)('preserves opt-outs and unset controls, route=%s', async (route) => {
      execFileMock.mockImplementation((command, args, options, callback) => {
        const child = Object.assign(new EventEmitter(), {
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          kill: () => false
        })
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
            expect(script).toContain(nested("'config'"))
            configReads++
          }
          const notice =
            route === 'newline' ? 'LOGIN_NOTICE:\n' : route === 'no-newline' ? 'LOGIN_NOTICE:' : ''
          program = '/bin/sh'
          commandArgs = ['-c', `printf %s ${quotePosixShell(notice)}; ${routed}`]
        } else {
          expect(command).toBe('git')
          expect(route).toBe('native')
          expect(args).toContain('config')
          configReads++
        }
        queueMicrotask(async () => {
          const selectedPlatform = process.platform
          platform(nativePlatform)
          try {
            const result = await runProcess({
              program,
              args: commandArgs,
              cwd: repo,
              env: { ...options.env, ...environment },
              timeoutMs: 10_000
            })
            platform(selectedPlatform)
            expect(result.timedOut).toBe(false)
            if (probe) {
              probeExits.push(result.code)
            }
            const error =
              result.code === 0
                ? null
                : Object.assign(new Error(result.stderr), { code: result.code })
            callback(error, result.stdout, result.stderr)
            child.emit('close', result.code)
          } catch (error) {
            platform(selectedPlatform)
            callback(error, '', '')
            child.emit('close', 1)
          }
        })
        return child
      })
      const wsl = route !== 'native'
      const options = wsl ? { wslDistro: 'Ubuntu' } : {}
      await resolveRunningWslDistros(async () => ['Ubuntu'], { requireConfirmed: true })
      noteWslDistrosRunning(['Ubuntu'])
      const signal = new AbortController().signal
      for (const setting of [
        { key: 'maintenance.auto', value: 'false', expected: true },
        { key: 'gc.auto', value: '0', expected: true },
        { key: 'maintenance.auto', value: 'true', expected: false }
      ]) {
        await writeFile(join(repo, '.git', 'config'), originalConfig)
        await git('config', setting.key, setting.value)
        const before = await readFile(join(repo, '.git', 'config'))
        platform(wsl ? 'win32' : nativePlatform)
        const target = createLocalRepoRefMaintenanceTarget({
          key: repo,
          repoPath: repo,
          ...options
        })
        if (!target.isOptedOut) {
          throw new Error('Maintenance target must expose its config probe')
        }
        expect(await target.isOptedOut(signal)).toBe(setting.expected)
        platform(nativePlatform)
        expect(await readFile(join(repo, '.git', 'config'))).toEqual(before)
      }
      for (const value of ['false', 'true', null]) {
        await writeFile(join(repo, '.git', 'config'), originalConfig)
        if (value !== null) {
          await git('config', 'core.multiPackIndex', value)
        }
        const before = await readFile(join(repo, '.git', 'config'))
        platform(wsl ? 'win32' : nativePlatform)
        expect(
          await maintainRepoPackIndex({
            repoPath: repo,
            commonDir: join(repo, '.git'),
            ...options,
            signal,
            span: { setAttribute: () => {} },
            canWrite: () => true
          })
        ).toBe(value === 'false' ? 'opted_out' : 'below_threshold')
        platform(nativePlatform)
        expect(await readFile(join(repo, '.git', 'config'))).toEqual(before)
      }
      expect(configReads).toBe(6)
      expect(probeExits).toEqual(wsl ? [78] : [])
    })
  }
)
