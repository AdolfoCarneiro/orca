import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { statMock, readFileMock } = vi.hoisted(() => ({
  statMock: vi.fn(),
  readFileMock: vi.fn()
}))

vi.mock('node:fs/promises', () => ({ stat: statMock, readFile: readFileMock }))

import {
  __resetLocalGitConfigSignatureCacheForTests,
  readLocalGitConfigSignature
} from './local-git-config-signature'

const repoPath = join(tmpdir(), 'orca-config-signature-traversal')
const gitDir = join(repoPath, '.git')
let files: Map<string, { text: string; mtime: number }>
let beforeStat: ((path: string) => Promise<void>) | undefined

function setConfig(name: string, text: string): string {
  const path = join(gitDir, name)
  files.set(path, { text, mtime: (files.get(path)?.mtime ?? 0) + 1 })
  return path
}

function signature(): Promise<string | undefined> {
  return readLocalGitConfigSignature({ repoPath })
}

function populateLeaves(count: number): Set<string> {
  setConfig(
    'config',
    `[include]\n${Array.from({ length: count }, (_, index) => `path = leaf${index}.cfg\n`).join('')}`
  )
  return new Set(
    Array.from({ length: count }, (_, index) =>
      setConfig(`leaf${index}.cfg`, '# included config\n')
    )
  )
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  __resetLocalGitConfigSignatureCacheForTests()
  files = new Map()
  beforeStat = undefined
  statMock.mockReset()
  readFileMock.mockReset()
  statMock.mockImplementation(async (path: string) => {
    await beforeStat?.(path)
    if (path === gitDir) {
      return { isDirectory: () => true }
    }
    const file = files.get(path)
    if (!file) {
      throw new Error('Config does not exist')
    }
    return { mtimeMs: file.mtime, size: file.text.length }
  })
  readFileMock.mockImplementation(async (path: string) => {
    const file = files.get(path)
    if (!file) {
      throw new Error('Config does not exist')
    }
    return file.text
  })
})

afterEach(() => {
  vi.useRealTimers()
  __resetLocalGitConfigSignatureCacheForTests()
})

describe('local Git config signature traversal', () => {
  it.each([10, 11])('signs only complete include graphs at depth %i', async (depth) => {
    for (let index = 0; index <= depth; index += 1) {
      setConfig(
        index === 0 ? 'config' : `depth${index}.cfg`,
        index === depth ? '# leaf\n' : `[include]\npath = depth${index + 1}.cfg\n`
      )
    }

    const result = await signature()
    if (depth === 10) {
      expect(result).toContain(join(gitDir, 'depth10.cfg'))
    } else {
      expect(result).toBeUndefined()
      expect(statMock).not.toHaveBeenCalledWith(join(gitDir, 'depth11.cfg'))
    }
  })

  it('bounds active reads while retaining every included leaf', async () => {
    const leaves = populateLeaves(12)
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let starts = 0
    beforeStat = async (path) => {
      if (leaves.has(path)) {
        starts += 1
        if (starts === 4) {
          started.resolve()
        }
        await release.promise
      }
    }

    const pending = signature()
    try {
      await started.promise
      expect(starts).toBe(4)
      expect(readFileMock.mock.calls.filter(([path]) => leaves.has(path))).toHaveLength(0)
    } finally {
      release.resolve()
      await pending
    }
    const result = await pending
    for (const path of leaves) {
      expect(result).toContain(path)
    }
    const lastLeaf = join(gitDir, 'leaf11.cfg')
    setConfig('leaf11.cfg', '# changed final leaf\n')
    expect(await signature()).not.toBe(result)
    expect(readFileMock).toHaveBeenCalledWith(lastLeaf, 'utf8')
  })

  it('shares expired work, stops pending reads, and permits a fresh scan after draining', async () => {
    const leaves = populateLeaves(12)
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let starts = 0
    beforeStat = async (path) => {
      if (leaves.has(path)) {
        starts += 1
        if (starts === 4) {
          started.resolve()
        }
        await release.promise
      }
    }

    const first = signature()
    const second = signature()
    try {
      await started.promise
      await vi.advanceTimersByTimeAsync(2_000)
      await expect(first).resolves.toBeUndefined()
      await expect(second).resolves.toBeUndefined()
      const joined = signature()
      const admitted = statMock.mock.calls.length
      expect(statMock.mock.calls.filter(([path]) => path === gitDir)).toHaveLength(1)
      release.resolve()
      await expect(joined).resolves.toBeUndefined()
      expect(statMock).toHaveBeenCalledTimes(admitted)
      expect(readFileMock.mock.calls.filter(([path]) => leaves.has(path))).toHaveLength(0)
    } finally {
      release.resolve()
      await Promise.all([first, second])
    }

    beforeStat = undefined
    const recovered = await signature()
    for (const path of leaves) {
      expect(recovered).toContain(path)
    }
    expect(statMock.mock.calls.filter(([path]) => path === gitDir)).toHaveLength(2)
  })

  it('includes config-path resolution in the shared admission deadline', async () => {
    setConfig('config', '# config\n')
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    beforeStat = async (path) => {
      if (path === gitDir) {
        started.resolve()
        await release.promise
      }
    }
    const first = signature()
    try {
      await started.promise
      await vi.advanceTimersByTimeAsync(2_000)
      await expect(first).resolves.toBeUndefined()
      const joined = signature()
      release.resolve()
      await expect(joined).resolves.toBeUndefined()
      expect(readFileMock).not.toHaveBeenCalled()
    } finally {
      release.resolve()
      await first
    }

    beforeStat = undefined
    expect(await signature()).toContain(join(gitDir, 'config'))
  })

  it('reuses a deep node at a shallow position and expands its remaining whitespace mode', async () => {
    setConfig('config', '[include]\npath = deep\t.cfg\npath = shared.cfg\n')
    setConfig('deep\t.cfg', '[include]\npath = a.cfg\n')
    setConfig('deep .cfg', '[include]\npath = shared.cfg\n')
    for (const [name, next] of [
      ['a.cfg', 'b.cfg'],
      ['b.cfg', 'c.cfg'],
      ['c.cfg', 'd.cfg'],
      ['d.cfg', 'shared.cfg']
    ]) {
      setConfig(name, `[include]\npath = ${next}\n`)
    }
    const shared = setConfig('shared.cfg', '[include]\npath = leaf\t.cfg\n')
    const literal = setConfig('leaf\t.cfg', '# literal\n')
    const legacy = setConfig('leaf .cfg', '# legacy\n')

    let previous = await signature()
    expect(previous).toContain(literal)
    expect(previous).toContain(legacy)
    expect(readFileMock.mock.calls.filter(([path]) => path === shared)).toHaveLength(1)
    for (const name of ['leaf\t.cfg', 'leaf .cfg']) {
      setConfig(name, '# edited mode-specific leaf\n')
      const changed = await signature()
      expect(changed).not.toBe(previous)
      previous = changed
    }
  })
})
