// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { getDefaultSettings } from '../../../../shared/constants'
import * as runtimePaths from '../../../../shared/cross-platform-path'
import { searchHit } from '../../../../shared/ai-vault-search-test-fixture'
import { useAppStore } from '../../store'
import * as providerAccounts from '@/runtime/runtime-provider-accounts-client'
import { SessionAccountSection } from './AiVaultSessionAccount'
import { useAiVaultSessionAccount } from './ai-vault-session-account'
import { aiVaultSearchHitToSession } from './ai-vault-search-session'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it.each([2, 20])('isolates settings publications across %i local account cards', async (count) => {
  const original = useAppStore.getState()
  const directorySize = 100
  const settings = {
    ...getDefaultSettings('/session-account-render'),
    claudeManagedAccounts: Array.from({ length: directorySize }, (_, index) => ({
      id: `claude-${index}`,
      email: `claude-${index}@example.com`,
      managedAuthPath: `/accounts/claude-${index}`,
      authMethod: 'unknown' as const,
      createdAt: 1,
      updatedAt: 1,
      lastAuthenticatedAt: 1
    })),
    codexManagedAccounts: Array.from({ length: directorySize }, (_, index) => ({
      id: `codex-${index}`,
      email: `codex-${index}@example.com`,
      managedHomePath: `/accounts/codex-${index}`,
      createdAt: 1,
      updatedAt: 1,
      lastAuthenticatedAt: 1
    }))
  }
  const snapshot = {
    claude: providerAccounts.emptyClaudeAccountsState(),
    codex: providerAccounts.emptyCodexAccountsState(),
    rateLimits: null
  }
  const fetchAccounts = vi
    .spyOn(providerAccounts, 'fetchProviderAccountsSnapshot')
    .mockResolvedValue(snapshot)
  const comparisons = vi.spyOn(runtimePaths, 'normalizeRuntimePathForComparison')
  const local: AiVaultSession[] = Array.from({ length: count }, (_, index) => {
    const agent = index % 2 === 0 ? 'claude' : 'codex'
    return {
      ...aiVaultSearchHitToSession(searchHit(), 'local'),
      id: `local-${index}`,
      agent,
      accountHome: {
        variable: agent === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME',
        path: `/accounts/${agent}-${directorySize - 1}`
      }
    }
  })
  const sessions: AiVaultSession[] = [
    ...local,
    { ...local[0]!, id: 'remote', executionHostId: 'runtime:other' },
    { ...local[0]!, id: 'default', accountHome: null },
    { ...local[0]!, id: 'old-response', accountHome: undefined }
  ]
  const renders = new Map<string, number>()
  function Card({ session }: { session: AiVaultSession }) {
    const label = useAiVaultSessionAccount(session)
    renders.set(session.id, (renders.get(session.id) ?? 0) + 1)
    return (
      <div data-testid={session.id}>
        <SessionAccountSection accountLabel={label} />
      </div>
    )
  }
  try {
    useAppStore.setState({ settings })
    const panel = render(sessions.map((session) => <Card key={session.id} session={session} />))
    await act(async () => {
      await Promise.resolve()
    })
    expect(panel.getByTestId('local-0').textContent).toContain('claude-99@example.com')
    expect(panel.getByTestId('local-1').textContent).toContain('codex-99@example.com')
    expect(panel.getByTestId('default').textContent).toContain('System default')
    expect(panel.getByTestId('old-response').textContent).toContain('Unknown')
    expect(panel.getByTestId('remote').textContent).toContain('Unknown')
    renders.clear()
    comparisons.mockClear()
    fetchAccounts.mockClear()

    for (const terminalFontSize of [settings.terminalFontSize + 1, settings.terminalFontSize + 2]) {
      await act(async () => useAppStore.setState({ settings: { ...settings, terminalFontSize } }))
      expect([...renders.values()]).toEqual([])
      expect(comparisons).not.toHaveBeenCalled()
      expect(fetchAccounts).not.toHaveBeenCalled()
    }

    await act(async () =>
      useAppStore.setState({
        settings: {
          ...settings,
          claudeManagedAccounts: settings.claudeManagedAccounts.map((account) => ({
            ...account,
            email: 'updated@example.com'
          }))
        }
      })
    )
    for (const session of sessions) {
      if (session.id.startsWith('local-') && session.agent === 'claude') {
        expect(renders.get(session.id)).toBeGreaterThan(0)
        expect(panel.getByTestId(session.id).textContent).toContain('updated@example.com')
      } else {
        expect(renders.get(session.id) ?? 0).toBe(0)
      }
    }
    expect(fetchAccounts).toHaveBeenCalledTimes(count / 2)
    expect(comparisons.mock.calls.length).toBeGreaterThan(0)
    expect(comparisons.mock.calls.length).toBeLessThanOrEqual(4 * directorySize * (count / 2))
  } finally {
    cleanup()
    useAppStore.setState(original, true)
  }
})
