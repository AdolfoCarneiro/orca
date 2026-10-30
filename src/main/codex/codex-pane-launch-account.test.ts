import * as fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveCodexLaunchHome } from './codex-launch-home'
import { describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { CodexManagedAccount } from '../../shared/managed-account-types'
import { resolveCodexPaneLaunchAccount } from './codex-pane-launch-account'

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof fs>()
  return { ...actual, lstatSync: vi.fn(actual.lstatSync) }
})

const SYSTEM_HOME = '/Users/example/.codex'

function managedAccount(overrides: Partial<CodexManagedAccount>): CodexManagedAccount {
  return {
    id: 'account-a',
    email: 'a@example.com',
    managedHomePath: '/data/codex-accounts/account-a/home',
    createdAt: 0,
    updatedAt: 0,
    lastAuthenticatedAt: 0,
    ...overrides
  }
}

function settings(args: {
  host?: string | null
  wsl?: Record<string, string | null>
  accounts?: CodexManagedAccount[]
}): GlobalSettings {
  return {
    activeCodexManagedAccountId: args.host ?? null,
    activeCodexManagedAccountIdsByRuntime: { host: args.host ?? null, wsl: args.wsl ?? {} },
    codexManagedAccounts: args.accounts ?? []
  } as GlobalSettings
}

describe('resolveCodexPaneLaunchAccount', () => {
  it('records the selected account for an ordinary spawn', () => {
    expect(
      resolveCodexPaneLaunchAccount({
        pinnedByResume: false,
        launchCodexHomePath: '/data/codex-accounts/account-b/home',
        systemCodexHomePath: SYSTEM_HOME,
        settings: settings({
          host: 'account-b',
          accounts: [
            managedAccount({
              id: 'account-b',
              managedHomePath: '/data/codex-accounts/account-b/home'
            })
          ]
        }),
        target: { runtime: 'host' }
      })
    ).toEqual({
      selectionKey: 'host',
      accountId: 'account-b',
      homeRoute: 'account-home'
    })
  })

  it('records the origin account a resume pinned the pane to, not the selection', () => {
    const accounts = [
      managedAccount({ id: 'account-a' }),
      managedAccount({ id: 'account-b', managedHomePath: '/data/codex-accounts/account-b/home' })
    ]

    expect(
      resolveCodexPaneLaunchAccount({
        pinnedByResume: true,
        launchCodexHomePath: '/data/codex-accounts/account-a/home',
        systemCodexHomePath: SYSTEM_HOME,
        settings: settings({ host: 'account-b', accounts }),
        target: { runtime: 'host' }
      })
    ).toEqual({
      selectionKey: 'host',
      accountId: 'account-a',
      homeRoute: 'account-home'
    })
  })

  it('maps a resume redirected to the real system home to the system-default account', () => {
    expect(
      resolveCodexPaneLaunchAccount({
        pinnedByResume: true,
        launchCodexHomePath: SYSTEM_HOME,
        systemCodexHomePath: SYSTEM_HOME,
        settings: settings({
          host: 'account-a',
          accounts: [managedAccount({ id: 'account-a' })]
        }),
        target: { runtime: 'host' }
      })
    ).toEqual({ selectionKey: 'host', accountId: null, homeRoute: 'real-home' })
  })

  it('maps a resume that injects no CODEX_HOME to the system-default account', () => {
    expect(
      resolveCodexPaneLaunchAccount({
        pinnedByResume: true,
        launchCodexHomePath: null,
        systemCodexHomePath: SYSTEM_HOME,
        settings: settings({ host: 'account-a', accounts: [managedAccount({ id: 'account-a' })] }),
        target: { runtime: 'host' }
      })
    ).toEqual({ selectionKey: 'host', accountId: null, homeRoute: 'real-home' })
  })

  it('refuses to attribute a resume home no account owns', () => {
    expect(
      resolveCodexPaneLaunchAccount({
        pinnedByResume: true,
        launchCodexHomePath: '/data/codex-runtime-home/home',
        systemCodexHomePath: SYSTEM_HOME,
        settings: settings({ host: 'account-a', accounts: [managedAccount({ id: 'account-a' })] }),
        target: { runtime: 'host' }
      })
    ).toBeNull()
  })

  it('does not let a host account answer for a WSL pane on the same path', () => {
    const accounts = [
      managedAccount({
        id: 'host-account',
        managedHomePath: '//wsl.localhost/Ubuntu/home/u/.codex'
      })
    ]

    expect(
      resolveCodexPaneLaunchAccount({
        pinnedByResume: true,
        launchCodexHomePath: '//wsl.localhost/Ubuntu/home/u/.codex',
        systemCodexHomePath: SYSTEM_HOME,
        settings: settings({ wsl: { Ubuntu: 'wsl-account' }, accounts }),
        target: { runtime: 'wsl', wslDistro: 'Ubuntu' }
      })
    ).toBeNull()
  })

  it('attributes a WSL resume home to the account on that distro lane', () => {
    const accounts = [
      managedAccount({
        id: 'wsl-account',
        managedHomeRuntime: 'wsl',
        wslDistro: 'Ubuntu',
        managedHomePath: '\\\\wsl$\\Ubuntu\\home\\u\\.codex-a'
      })
    ]

    expect(
      resolveCodexPaneLaunchAccount({
        pinnedByResume: true,
        launchCodexHomePath: '//wsl.localhost/Ubuntu/home/u/.codex-a',
        systemCodexHomePath: SYSTEM_HOME,
        settings: settings({ wsl: { Ubuntu: 'other-wsl-account' }, accounts }),
        target: { runtime: 'wsl', wslDistro: 'Ubuntu' }
      })
    ).toEqual({
      selectionKey: 'wsl:Ubuntu',
      accountId: 'wsl-account',
      homeRoute: 'account-home'
    })
  })

  it('attributes a mounted-drive WSL launch through its distro UNC spelling', () => {
    const account = managedAccount({
      id: 'drive-account',
      managedHomePath: 'C:\\Users\\u\\orca\\codex-accounts\\drive-account\\home',
      managedHomeRuntime: 'wsl',
      wslDistro: 'Ubuntu',
      wslLinuxHomePath: '/mnt/c/Users/u/orca/codex-accounts/drive-account/home'
    })
    const args = {
      launchCodexHomePath:
        '\\\\wsl.localhost\\Ubuntu\\mnt\\c\\Users\\u\\orca\\codex-accounts\\drive-account\\home',
      systemCodexHomePath: SYSTEM_HOME,
      settings: settings({ wsl: { Ubuntu: 'drive-account' }, accounts: [account] }),
      target: { runtime: 'wsl' as const, wslDistro: 'Ubuntu' }
    }

    expect(resolveCodexPaneLaunchAccount({ ...args, pinnedByResume: false })).toEqual({
      selectionKey: 'wsl:Ubuntu',
      accountId: 'drive-account',
      homeRoute: 'account-home'
    })
    expect(resolveCodexPaneLaunchAccount({ ...args, pinnedByResume: true })).toEqual({
      selectionKey: 'wsl:Ubuntu',
      accountId: 'drive-account',
      homeRoute: 'account-home'
    })
  })

  it('tolerates settings that carry no managed account roster', () => {
    expect(
      resolveCodexPaneLaunchAccount({
        pinnedByResume: true,
        launchCodexHomePath: '/data/codex-accounts/account-a/home',
        systemCodexHomePath: SYSTEM_HOME,
        settings: { activeCodexManagedAccountId: null } as GlobalSettings,
        target: { runtime: 'host' }
      })
    ).toBeNull()
  })
})

it('independently sufficient direct and canonical legacy B survive A IO while incomplete negative stays unknown', async () => {
  const actual = await vi.importActual<typeof fs>('node:fs')
  const root = actual.realpathSync(actual.mkdtempSync(join(tmpdir(), 'orca-legacy-evidence-')))
  const accountsRoot = join(root, 'codex-accounts'),
    system = join(root, 'system')
  const A = join(accountsRoot, 'a', 'home'),
    B = join(accountsRoot, 'b', 'home')
  for (const home of [A, B, system]) {
    actual.mkdirSync(home, { recursive: true })
  }
  actual.writeFileSync(join(A, '.orca-managed-home'), 'a')
  actual.writeFileSync(join(B, '.orca-managed-home'), 'b')
  const actor = resolveCodexLaunchHome({
    selectedAccount: { homePath: B, id: 'b' },
    systemHome: system,
    accountsRoot,
    storeHome: system
  })!
  const roster = [
    managedAccount({ id: 'a', managedHomePath: A }),
    managedAccount({ id: 'b', managedHomePath: B })
  ]
  const resolve = (home: string, accounts = roster) =>
    resolveCodexPaneLaunchAccount({
      launchCodexHomePath: home,
      systemCodexHomePath: system,
      pinnedByResume: true,
      settings: settings({ accounts }),
      target: { runtime: 'host' }
    })
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.mocked(fs.lstatSync).mockImplementation((...args: Parameters<typeof actual.lstatSync>) => {
    if (String(args[0]) === join(A, '.orca-managed-home')) {
      throw Object.assign(new Error('A denied'), { code: 'EACCES' })
    }
    return actual.lstatSync(...args)
  })
  try {
    expect(resolve(B)).toMatchObject({ accountId: 'b', homeRoute: 'account-home' })
    expect(resolve(actor)).toMatchObject({ accountId: 'b', homeRoute: 'account-home' })
    expect(resolve(join(root, 'unknown'))).toBeNull()
    expect(resolve(A.replace('/home', `/overlays/${'f'.repeat(32)}`))).toBeNull()
    expect(resolve(B, [roster[1]!, { ...roster[1]!, id: 'duplicate' }])).toMatchObject({
      accountId: 'b'
    })
  } finally {
    vi.mocked(fs.lstatSync).mockImplementation(actual.lstatSync)
    warn.mockRestore()
    actual.rmSync(root, { recursive: true, force: true })
  }
})
