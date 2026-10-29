import { beforeEach, describe, expect, it, vi } from 'vitest'

const { readFileMock, statMock, lstatMock } = vi.hoisted(() => ({
  readFileMock: vi.fn(),
  statMock: vi.fn(),
  lstatMock: vi.fn()
}))

vi.mock('node:fs/promises', () => ({
  readFile: readFileMock,
  stat: statMock,
  lstat: lstatMock
}))

import { readWorktreeDiffStamp } from './source-control/worktree-diff-stamp'

describe('diff stamp with an unattested WSL Git environment', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it.each([
    ['/mnt/c/wt/x', { wslDistro: 'Ubuntu' }],
    [String.raw`\\wsl.localhost\Ubuntu\home\me\repo`, {}],
    [String.raw`\\wsl$\Ubuntu\home\me\repo`, {}]
  ])('declines %s before filesystem work', async (worktree, options) => {
    expect(await readWorktreeDiffStamp(worktree, 'src/a.ts', true, options)).toBeNull()
    expect(readFileMock).not.toHaveBeenCalled()
    expect(statMock).not.toHaveBeenCalled()
    expect(lstatMock).not.toHaveBeenCalled()
  })

  it.each(['refs/custom-replace/', 'refs/custom-replace', ''])(
    'declines the visible custom replacement prefix %j before filesystem work',
    async (prefix) => {
      vi.stubEnv('GIT_REPLACE_REF_BASE', prefix)
      try {
        expect(await readWorktreeDiffStamp('/repo', 'src/a.ts', true)).toBeNull()
        expect(readFileMock).not.toHaveBeenCalled()
        expect(statMock).not.toHaveBeenCalled()
        expect(lstatMock).not.toHaveBeenCalled()
      } finally {
        vi.unstubAllEnvs()
      }
    }
  )
})
