import type * as NodeOs from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDefaultSettings } from '../../shared/constants'
import { safeRemoveTree } from '../pty/overlay-mirror'
import { GUEST_CODEX_ACCOUNTS_ROOT_SEGMENTS } from '../codex-accounts/guest-codex-account-homes'
import {
  type CodexHomePreparationOperation,
  codexConversationStore
} from '../codex/codex-launch-home'

const state = vi.hoisted(() => ({ home: '', wsl: false, hooks: vi.fn(async () => {}) }))
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeOs>()),
  homedir: () => state.home
}))
vi.mock('../ipc/wsl-guest-windows-drive-path', () => ({ isWslHostOrcadProcess: () => state.wsl }))
vi.mock('../codex/codex-account-home-hook', () => ({ reconcileCodexAccountHomeHook: state.hooks }))
vi.mock('../codex/codex-state-db-backfill-recovery', () => ({
  stopCodexStateDbBackfillRecoveries: vi.fn()
}))
import { orcadCodexAccountHomes } from './orcad-codex-account-homes'

describe.skipIf(process.platform === 'win32')('orcadCodexAccountHomes', () => {
  let login: string
  let store: string
  beforeEach(() => {
    state.home = realpathSync(mkdtempSync(join(tmpdir(), 'codex-guest-actors-')))
    state.wsl = false
    state.hooks.mockClear()
    login = join(state.home, ...GUEST_CODEX_ACCOUNTS_ROOT_SEGMENTS, 'a1', 'home')
    store = join(state.home, 'source')
    mkdirSync(login, { recursive: true })
    mkdirSync(store)
    writeFileSync(join(login, '.orca-managed-home'), 'a1')
    writeFileSync(join(login, 'auth.json'), '{"account":"current"}')
  })
  afterEach(() => safeRemoveTree(state.home))

  function homes() {
    return orcadCodexAccountHomes(
      () => ({ ...getDefaultSettings(state.home), codexSessionSourceHome: { host: store } }),
      () => {}
    )
  }

  it('reads H without constructing, shares one fresh preparation, and retains exact detached O on reads', async () => {
    const h = homes()
    const env = { CODEX_HOME: login }
    expect(h.readLaunchHome(env)).toBe(login)
    expect(h.listSessionHomes()).toEqual([login])
    const operation: CodexHomePreparationOperation = {}
    const actor = (await h.selectLaunchHome(undefined, env, { operation }))!
    expect(await h.selectLaunchHome(undefined, env, { operation })).toBe(actor)
    expect(codexConversationStore(actor)).toBe(store)
    unlinkSync(join(actor, 'auth.json'))
    writeFileSync(join(actor, 'auth.json'), '{"account":"private"}')
    expect(h.readLaunchHome({ CODEX_HOME: actor })).toBe(actor)
    const fresh = (await h.selectLaunchHome(undefined, { CODEX_HOME: actor }))!
    expect(fresh).not.toBe(actor)
    expect(readFileSync(join(fresh, 'auth.json'), 'utf8')).toContain('current')
    expect(readFileSync(join(actor, 'auth.json'), 'utf8')).toContain('private')
    expect(h.listSessionHomes()).toEqual(expect.arrayContaining([login, actor, fresh, store]))
    expect(state.hooks).toHaveBeenCalledWith(fresh, expect.any(Function), false)
  })

  it('preserves the desktop-prepared WSL route on read and actual launch', async () => {
    const h = homes()
    const actor = (await h.selectLaunchHome(undefined, { CODEX_HOME: login }))!
    state.wsl = true
    expect(h.readLaunchHome({ CODEX_HOME: actor })).toBe(actor)
    expect(
      await h.selectLaunchHome(
        undefined,
        { CODEX_HOME: actor },
        { conversationHome: '/ignored/desktop-source', launchesCodex: true }
      )
    ).toBe(actor)
    expect(state.hooks).toHaveBeenLastCalledWith(actor, expect.any(Function), true)
    expect(h.listSessionHomes().filter((home) => home.includes('/overlays/'))).toHaveLength(1)
  })

  it('leaves user homes outside the owned guest root alone', async () => {
    const h = homes()
    expect(h.readLaunchHome({ CODEX_HOME: join(state.home, '.codex') })).toBeNull()
    expect(await h.selectLaunchHome(undefined, {})).toBeNull()
    expect(state.hooks).not.toHaveBeenCalled()
  })
})
