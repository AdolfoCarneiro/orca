import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const state = vi.hoisted(() => ({
  userData: '',
  managed: '',
  system: '',
  blocked: '',
  code: '',
  walks: new Array<string>()
}))

vi.mock('../codex/codex-home-paths', () => ({
  getOrcaUserDataPath: () => state.userData,
  getOrcaManagedCodexHomePath: () => state.managed,
  getSystemCodexHomePath: () => state.system
}))

vi.mock('../codex/codex-session-bridge', () => ({
  getLegacyCopiedCodexSessionBridgeScanPreference: () => null
}))

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof FsPromises>('node:fs/promises')
  return {
    ...actual,
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      state.walks.push(String(args[0]))
      if (String(args[0]) === state.blocked) {
        throw Object.assign(new Error(`Cannot discover ${state.blocked}`), { code: state.code })
      }
      return actual.readdir(...args)
    }
  }
})

import { listCodexSessionFiles } from './codex-session-file-discovery'

let root: string
let sessions: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-codex-discovery-error-'))
  state.userData = join(root, 'user-data')
  state.walks = []
  state.managed = join(root, 'managed')
  state.system = join(root, 'system')
  state.blocked = ''
  state.code = ''
  sessions = join(state.managed, 'sessions')
  await mkdir(sessions, { recursive: true })
  await mkdir(join(state.system, 'sessions'), { recursive: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('Codex history discovery failures', () => {
  it.each([8, 80])(
    'walks the physical store once with %i retained actor aliases, including repeated operations',
    async (count) => {
      const login = join(state.userData, 'codex-accounts', 'a', 'home')
      await mkdir(login, { recursive: true })
      await writeFile(join(login, '.orca-managed-home'), 'a')
      const rollout = join(sessions, 'day', 'rollout.jsonl')
      await mkdir(join(sessions, 'day'))
      await writeFile(rollout, 'fixture')
      for (let i = 0; i < count; i++) {
        const actor = join(
          state.userData,
          'codex-accounts',
          'a',
          'overlays',
          i.toString(16).padStart(32, '0')
        )
        await mkdir(actor, { recursive: true })
        await symlink(
          sessions,
          join(actor, 'sessions'),
          process.platform === 'win32' ? 'junction' : 'dir'
        )
      }
      for (let pass = 0; pass < 2; pass++) {
        state.walks = []
        expect(await listCodexSessionFiles()).toEqual([rollout])
        expect(state.walks.filter((path) => path === sessions)).toHaveLength(1)
        expect(state.walks.filter((path) => path.endsWith('day'))).toHaveLength(1)
        expect(state.walks.some((path) => path.includes('/overlays/'))).toBe(false)
      }
    }
  )

  it.each(['EACCES', 'EPERM', 'EIO', 'UNKNOWN'])(
    'rejects an inaccessible root (%s)',
    async (code) => {
      state.blocked = sessions
      state.code = code
      await expect(listCodexSessionFiles()).rejects.toMatchObject({ code })
    }
  )

  it('rejects an unreadable child instead of publishing an incomplete history list', async () => {
    await writeFile(join(sessions, 'kept.jsonl'), '')
    state.blocked = join(sessions, 'inaccessible')
    await mkdir(state.blocked)
    state.code = 'EACCES'
    await expect(listCodexSessionFiles()).rejects.toMatchObject({ code: 'EACCES' })
  })

  it.each(['ENOENT', 'ENOTDIR'])(
    'keeps sibling files when a child disappears (%s)',
    async (code) => {
      const sibling = join(sessions, 'kept.jsonl')
      await writeFile(sibling, '')
      state.blocked = join(sessions, 'removed')
      await mkdir(state.blocked)
      state.code = code
      await expect(listCodexSessionFiles()).resolves.toEqual([sibling])
    }
  )

  it('accepts absent homes while preserving the available history', async () => {
    const sibling = join(sessions, 'kept.jsonl')
    await writeFile(sibling, '')
    await rm(state.system, { recursive: true })
    await expect(listCodexSessionFiles()).resolves.toEqual([sibling])
  })
})
