import { describe, expect, it, vi } from 'vitest'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { resolveAiVaultSessionAccount } from './ai-vault-session-account'
import { aiVaultSearchHitToSession } from './ai-vault-search-session'
import { searchHit } from '../../../../shared/ai-vault-search-test-fixture'

vi.mock('../../store', () => ({ useAppStore: vi.fn() }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

const claude = {
  id: 'recorded',
  email: 'recorded@example.com',
  managedAuthPath: '/accounts/claude',
  authMethod: 'unknown' as const,
  createdAt: 1,
  updatedAt: 1,
  lastAuthenticatedAt: 1
}
const codex = {
  id: 'recorded',
  email: 'recorded@example.com',
  managedHomePath: '/accounts/codex',
  createdAt: 1,
  updatedAt: 1,
  lastAuthenticatedAt: 1
}
const settings = {
  claudeManagedAccounts: [claude],
  codexManagedAccounts: [codex],
  activeClaudeManagedAccountId: 'another',
  activeCodexManagedAccountId: 'another'
}

function session(agent: AiVaultSession['agent'], path: string): AiVaultSession {
  return {
    ...aiVaultSearchHitToSession(searchHit(), 'local'),
    agent,
    accountHome: { variable: agent === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME', path }
  }
}

describe('session account labels', () => {
  it.each(['claude', 'codex'] as const)(
    'uses the recorded %s folder despite a different selection',
    (agent) => {
      const recorded = session(agent, `/accounts/${agent}`)
      expect(resolveAiVaultSessionAccount(recorded, settings, null)).toBe('recorded@example.com')
      const changedSelection = {
        ...settings,
        activeClaudeManagedAccountId: 'third',
        activeCodexManagedAccountId: 'third'
      }
      expect(resolveAiVaultSessionAccount(recorded, changedSelection, null)).toBe(
        'recorded@example.com'
      )
      expect(resolveAiVaultSessionAccount({ ...recorded, accountHome: null }, settings, null)).toBe(
        'System default'
      )
      for (const unknown of [
        { ...recorded, accountHome: undefined },
        { ...recorded, executionHostId: 'runtime:other' as const },
        { ...recorded, accountHome: null, executionHostId: 'runtime:other' as const },
        session(agent, '/custom/config')
      ])
        expect(resolveAiVaultSessionAccount(unknown, settings, null)).toBeNull()
    }
  )

  it('uses the current Claude profile home and email ahead of the obsolete saved folder', () => {
    const accounts = {
      claude: {
        activeAccountId: 'another',
        accounts: [{ ...claude, home: '/profiles/current', email: 'current@example.com' }]
      }
    }
    expect(
      resolveAiVaultSessionAccount(session('claude', '/profiles/current'), settings, accounts)
    ).toBe('current@example.com')
    expect(
      resolveAiVaultSessionAccount(session('claude', claude.managedAuthPath), settings, accounts)
    ).toBeNull()
    expect(
      resolveAiVaultSessionAccount(session('claude', claude.managedAuthPath), settings, {
        claude: {
          activeAccountId: 'another',
          accounts: [{ ...claude, email: 'older-server@example.com' }]
        }
      })
    ).toBe('older-server@example.com')
  })

  it('uses the same current Codex label as the account menu', () => {
    expect(
      resolveAiVaultSessionAccount(session('codex', codex.managedHomePath), settings, {
        codex: {
          activeAccountId: 'another',
          accounts: [{ ...codex, email: 'current@example.com', workspaceLabel: 'Team' }]
        }
      })
    ).toBe('current@example.com (Team)')
  })

  it('compares Windows paths and requires the recorded WSL distro for Linux homes', () => {
    expect(
      resolveAiVaultSessionAccount(
        session('codex', 'C:\\ACCOUNTS\\CODEX\\'),
        {
          ...settings,
          codexManagedAccounts: [{ ...codex, managedHomePath: 'c:/accounts/codex' }]
        },
        null
      )
    ).toBe(codex.email)
    const wslSettings = {
      ...settings,
      claudeManagedAccounts: [
        {
          ...claude,
          managedAuthRuntime: 'wsl' as const,
          wslDistro: 'Ubuntu',
          wslLinuxAuthPath: '/home/me/.claude'
        }
      ]
    }
    const wsl = { ...session('claude', '/home/me/.claude'), accountWslDistro: 'Ubuntu' }
    expect(resolveAiVaultSessionAccount(wsl, wslSettings, null)).toBe(claude.email)
    expect(
      resolveAiVaultSessionAccount({ ...wsl, accountWslDistro: 'Debian' }, wslSettings, null)
    ).toBeNull()
    expect(
      resolveAiVaultSessionAccount({ ...wsl, accountWslDistro: undefined }, wslSettings, null)
    ).toBeNull()
  })

  it('resolves a saved data profile by its recorded id, and leaves unsupported agents unknown', () => {
    const profileId = '019fd532-7c11-7a90-b6de-4e1a2c3d5f60'
    const recorded = {
      ...session('opencode', '/unused'),
      accountHome: {
        kind: 'opencode' as const,
        locator: { kind: 'managed' as const, managedProfileId: profileId }
      }
    }
    expect(
      resolveAiVaultSessionAccount(recorded, settings, {
        opencode: {
          activeAccountId: 'profile-b',
          accounts: [{ id: profileId, label: 'Work', integrations: [], createdAt: 1 }]
        }
      })
    ).toBe('Work')
    expect(
      resolveAiVaultSessionAccount(
        {
          ...recorded,
          accountHome: { kind: 'opencode', locator: { kind: 'unmanaged' } }
        },
        settings,
        null
      )
    ).toBe('System default')
    expect(resolveAiVaultSessionAccount(session('pi', '/pi'), settings, null)).toBeNull()
  })
})
