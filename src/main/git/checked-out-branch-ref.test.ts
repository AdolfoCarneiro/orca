import { beforeEach, describe, expect, it, vi } from 'vitest'

const { exec } = vi.hoisted(() => ({ exec: vi.fn() }))
vi.mock('./runner', () => ({ gitExecFileAsync: exec }))
import { readCheckedOutBranchState } from './checked-out-branch-ref'
import { readCheckedOutBranchRef } from './worktree-list-reader'

beforeEach(() => {
  exec.mockReset()
})

describe('checked-out branch state', () => {
  it.each(['refs/heads/main\n', 'refs/tags/control\n', 'refs/heads/\u00a0branch\u00a0\r\n'])(
    'retains the full native symbolic ref: %s',
    async (stdout) => {
      exec.mockResolvedValue({ stdout, stderr: '' })
      expect(await readCheckedOutBranchState('/repo')).toEqual({
        kind: 'symbolic',
        ref: stdout.replace(/\r?\n$/, '')
      })
    }
  )

  it.each(['', 'main\n', 'refs/heads/one\nrefs/heads/two\n', 'refs/heads/bad\ufffd\n'])(
    'declines incomplete or lossy native output: %s',
    async (stdout) => {
      exec.mockResolvedValue({ stdout, stderr: '' })
      expect(await readCheckedOutBranchState('/repo')).toEqual({ kind: 'unknown' })
    }
  )

  it('accepts only a quiet, completed native exit 1 as detached', async () => {
    exec.mockRejectedValue(
      Object.assign(new Error('detached'), {
        code: 1,
        stdout: '',
        stderr: '',
        killed: false,
        signal: null
      })
    )
    expect(await readCheckedOutBranchState('/repo')).toEqual({ kind: 'detached' })
  })

  it.each([
    { code: 128 },
    { code: 'ENOENT' },
    { code: 1, stderr: 'failed' },
    { code: 1, stdout: 'partial' },
    { code: 1, killed: true },
    { code: 1, signal: 'SIGTERM' },
    { code: 1, name: 'AbortError' },
    { code: 1, timedOut: true },
    { code: 1, outputTruncated: true }
  ])('keeps an unavailable native result distinct from detached: %j', async (failure) => {
    exec.mockRejectedValue(
      Object.assign(new Error('unavailable'), { stdout: '', stderr: '', ...failure })
    )
    expect(await readCheckedOutBranchState('/repo')).toEqual({ kind: 'unknown' })
  })

  it('does not classify an aborted quiet exit as detached', async () => {
    const controller = new AbortController()
    exec.mockImplementation(async () => {
      controller.abort()
      throw Object.assign(new Error('aborted'), { code: 1, stdout: '', stderr: '' })
    })
    expect(await readCheckedOutBranchState('/repo', { signal: controller.signal })).toEqual({
      kind: 'unknown'
    })
  })

  it('preserves successful convenience stdout after abort while the strict reader declines it', async () => {
    const controller = new AbortController()
    exec.mockImplementation(async () => {
      controller.abort()
      return { stdout: 'refs/heads/main\n', stderr: '' }
    })
    expect(await readCheckedOutBranchRef('/repo', { signal: controller.signal })).toBe(
      'refs/heads/main'
    )
    expect(await readCheckedOutBranchState('/repo', { signal: controller.signal })).toEqual({
      kind: 'unknown'
    })
  })

  it('preserves the existing convenience reader trimming and failure behavior', async () => {
    exec.mockResolvedValueOnce({ stdout: ' refs/heads/main\ufffd\n', stderr: '' })
    expect(await readCheckedOutBranchRef('/repo')).toBe('refs/heads/main\ufffd')
    exec.mockRejectedValueOnce(new Error('unavailable'))
    expect(await readCheckedOutBranchRef('/repo')).toBeUndefined()
  })
})
