import { beforeEach, describe, expect, it, vi } from 'vitest'

const { readFileMock, statMock, lstatMock } = vi.hoisted(() => ({
  readFileMock: vi.fn(),
  statMock: vi.fn(),
  lstatMock: vi.fn()
}))

vi.mock('fs/promises', () => ({
  readFile: readFileMock,
  stat: statMock,
  lstat: lstatMock
}))

import { readWorktreeDiffStamp } from './source-control/worktree-diff-stamp'

const slashed = (value: unknown): string => String(value).replaceAll('\\', '/')
const missing = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' })

// Stamp working files in host spelling too; an always-missing guest path would make edits invisible.
describe('readWorktreeDiffStamp on a drvfs-spelled WSL worktree', () => {
  beforeEach(() => {
    readFileMock.mockReset()
    statMock.mockReset()
    lstatMock.mockRejectedValue(missing())
    readFileMock.mockImplementation(async (target: string) => {
      const value = slashed(target)
      if (value === 'C:/repo/wt/.git') {
        return 'gitdir: /mnt/c/repo/.git/worktrees/wt\n'
      }
      if (value === 'C:/repo/.git/worktrees/wt/HEAD') {
        return `${'a'.repeat(40)}\n`
      }
      throw missing()
    })
    statMock.mockImplementation(async (target: string) => {
      const value = slashed(target)
      if (value === 'C:/repo/.git/worktrees/wt/refs') {
        return { mtimeMs: 500, size: 0, ino: 8 }
      }
      if (value === 'C:/repo/wt/src/a.ts') {
        return { mtimeMs: 1_000, size: 12, ino: 7 }
      }
      throw missing()
    })
  })

  it('stamps the working-tree file through the same host spelling as the gitdir', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')

    try {
      const stamp = await readWorktreeDiffStamp('/mnt/c/repo/wt', 'src/a.ts', true)

      expect(stamp).not.toBeNull()
      expect(statMock.mock.calls.map(([target]) => slashed(target))).toContain(
        'C:/repo/wt/src/a.ts'
      )
      expect(stamp?.newestMtimeMs).toBe(1_000)
    } finally {
      platformSpy.mockRestore()
    }
  })
})
