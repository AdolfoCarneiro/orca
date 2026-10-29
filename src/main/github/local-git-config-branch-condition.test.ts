import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type CaptureOptions = { signal?: AbortSignal; onChildTerminated?: () => void }
const { capture, statMock, readFileMock } = vi.hoisted(() => ({
  capture:
    vi.fn<
      (
        binary: string,
        args: string[],
        options: CaptureOptions
      ) => Promise<{ stdout: string; stderr: string }>
    >(),
  statMock: vi.fn(),
  readFileMock: vi.fn()
}))
vi.mock('node:fs/promises', () => ({ stat: statMock, readFile: readFileMock }))
vi.mock('../git/runner', async () => import('../git/command-runner/git-exec-file'))
vi.mock('../git/command-runner/exec-file-capture', () => ({
  execFileCapture: capture,
  execFileCaptureToTermination: capture
}))
vi.mock('../observability/instrumentation', () => ({
  withGitSpan: (_attributes: unknown, run: () => unknown) => run()
}))
import {
  GitAdmissionScheduler,
  acquireGitAdmission,
  _gitAdmissionSnapshotForTests,
  _resetGitAdmissionForTests
} from '../git/command-runner/git-subprocess-admission'
import { listCachedRemoteNames, _resetRemoteNameListingCache } from '../git/remote-name-listing'
import {
  __resetLocalGitConfigSignatureCacheForTests,
  readLocalGitConfigSignature
} from './local-git-config-signature'

const repoPath = join(tmpdir(), 'orca-config-branch-admission')
const gitDir = join(repoPath, '.git')
let files: Map<string, string>

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  vi.stubEnv('ORCA_GIT_ADMISSION_DISABLED', '0')
  __resetLocalGitConfigSignatureCacheForTests()
  _resetRemoteNameListingCache()
  _resetGitAdmissionForTests()
  files = new Map([[join(gitDir, 'config'), '[includeIf "onbranch:*"] path = child.cfg\n']])
  statMock.mockReset().mockImplementation(async (path: string) => {
    if (path === gitDir) {
      return { isDirectory: () => true }
    }
    const text = files.get(path)
    if (text === undefined) {
      throw new Error('Absent fixture file')
    }
    return { mtimeMs: 1, size: text.length }
  })
  readFileMock.mockReset().mockImplementation(async (path: string) => {
    const text = files.get(path)
    if (text === undefined) {
      throw new Error('Absent fixture file')
    }
    return text
  })
  capture.mockReset().mockImplementation(async (_binary, args, options) => {
    options.onChildTerminated?.()
    return { stdout: args[0] === 'remote' ? 'origin\n' : 'refs/heads/before\n', stderr: '' }
  })
})

afterEach(() => {
  _resetGitAdmissionForTests()
  __resetLocalGitConfigSignatureCacheForTests()
  _resetRemoteNameListingCache()
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

const signature = () => readLocalGitConfigSignature({ repoPath })

describe('conditional signature scans', () => {
  it.each([
    { text: '# [includeIf "onbranch:*"] path = child.cfg\n', probes: 0 },
    { text: '[include] path = child.cfg\n', probes: 0 },
    { text: '[include "subsection"] path = child.cfg\n', probes: 0 },
    { text: '[core] ignored = prefix\\\n[includeIf "onbranch:*"] path = child.cfg\n', probes: 0 },
    { text: '[core][includeIf "gitdir:never"] path = child.cfg\n', probes: 1 },
    { text: '[remote "unused\\\"tail"][includeIf "onbranch:*"] path = child.cfg\n', probes: 1 },
    { text: '[includeIf "onbranch:*"] ignored = prefix\\\n[core]\npath = child.cfg\n', probes: 1 }
  ])('uses parsed conditional metadata: $text', async ({ text, probes }) => {
    files.set(join(gitDir, 'config'), text)
    const first = await signature()
    expect(first).toBeDefined()
    expect(capture).toHaveBeenCalledTimes(probes)
    capture.mockImplementation(async (_binary, _args, options) => {
      options.onChildTerminated?.()
      return { stdout: 'refs/heads/after\n', stderr: '' }
    })
    const second = await signature()
    if (probes) {
      expect(second).not.toBe(first)
    } else {
      expect(second).toBe(first)
    }
  })

  it('aggregates nested conditional metadata and preserves ordinary signature bytes', async () => {
    files.set(join(gitDir, 'config'), '[include] path = child.cfg\n')
    files.set(join(gitDir, 'child.cfg'), '# ordinary\n')
    const ordinary = await signature()
    const expected = [
      `${join(gitDir, 'config')}\0${1}\0${files.get(join(gitDir, 'config'))?.length}`,
      `${join(gitDir, 'child.cfg')}\0${1}\0${files.get(join(gitDir, 'child.cfg'))?.length}`,
      `${join(gitDir, 'config.worktree')}\0missing`
    ]
      .sort()
      .join('\0')
    expect(ordinary).toBe(expected)
    expect(capture).not.toHaveBeenCalled()
    files.set(join(gitDir, 'child.cfg'), '[includeIf "onbranch:*"] path = absent.cfg\n')
    expect(await signature()).toBeDefined()
    expect(capture).toHaveBeenCalledTimes(1)
  })

  it('propagates the listing caller tier through both cold signature scans', async () => {
    const tiers: string[] = []
    _resetGitAdmissionForTests(
      new GitAdmissionScheduler({
        onAdmissionEvent: (event) => {
          if (event.phase === 'grant') {
            tiers.push(event.tier)
          }
        }
      })
    )
    expect(
      await listCachedRemoteNames(repoPath, undefined, { admissionTier: 'background' })
    ).toEqual(['origin'])
    expect(tiers).toEqual(['background', 'background', 'background'])
    expect(capture.mock.calls.map(([, args]) => args[0])).toEqual([
      'symbolic-ref',
      'remote',
      'symbolic-ref'
    ])
  })

  it('cancels queued admission at the shared deadline without a late spawn', async () => {
    _resetGitAdmissionForTests(new GitAdmissionScheduler({ generalCap: 1, generalHeadroom: 0 }))
    const blocker = await acquireGitAdmission({ args: ['status'], cwd: repoPath })
    try {
      const pending = signature()
      await vi.waitFor(() => expect(_gitAdmissionSnapshotForTests().queued).toBe(1))
      await vi.advanceTimersByTimeAsync(2_000)
      await expect(pending).resolves.toBeUndefined()
      expect(_gitAdmissionSnapshotForTests().queued).toBe(0)
      blocker.release()
      await vi.advanceTimersByTimeAsync(0)
      expect(capture).not.toHaveBeenCalled()
      expect(await signature()).toBeDefined()
    } finally {
      blocker.release()
    }
  })

  it('rechecks the absolute deadline after a grant even before its timer runs', async () => {
    _resetGitAdmissionForTests(
      new GitAdmissionScheduler({
        onAdmissionEvent: (event) => {
          if (event.phase === 'grant') {
            vi.setSystemTime(2_000)
          }
        }
      })
    )
    expect(await signature()).toBeUndefined()
    expect(capture).not.toHaveBeenCalled()
    expect(_gitAdmissionSnapshotForTests().budgets.general?.baseUsed).toBe(0)
  })

  it('keeps an aborted running probe shared until its termination barrier settles', async () => {
    const started = Promise.withResolvers<void>()
    const aborted = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    capture.mockImplementationOnce(async (_binary, _args, options) => {
      started.resolve()
      options.signal?.addEventListener('abort', () => aborted.resolve(), { once: true })
      await release.promise
      options.onChildTerminated?.()
      throw Object.assign(new Error('aborted'), {
        name: 'AbortError',
        code: 1,
        stdout: '',
        stderr: ''
      })
    })
    const first = signature()
    const second = signature()
    try {
      await started.promise
      await vi.advanceTimersByTimeAsync(2_000)
      await aborted.promise
      await expect(first).resolves.toBeUndefined()
      await expect(second).resolves.toBeUndefined()
      const joined = signature()
      expect(capture).toHaveBeenCalledTimes(1)
      expect(_gitAdmissionSnapshotForTests().budgets.general?.baseUsed).toBe(1)
      release.resolve()
      await expect(joined).resolves.toBeUndefined()
      expect(_gitAdmissionSnapshotForTests().budgets.general?.baseUsed).toBe(0)
      expect(await signature()).toBeDefined()
      expect(capture).toHaveBeenCalledTimes(2)
    } finally {
      release.resolve()
      await Promise.all([first, second])
    }
  })
})
