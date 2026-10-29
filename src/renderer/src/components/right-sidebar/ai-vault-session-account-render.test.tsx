// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { getDefaultSettings } from '../../../../shared/constants'
import * as runtimePaths from '../../../../shared/cross-platform-path'
import { searchHit } from '../../../../shared/ai-vault-search-test-fixture'
import { useAppStore } from '../../store'
import * as providerAccounts from '@/runtime/runtime-provider-accounts-client'
import * as rpc from '@/runtime/runtime-rpc-client'
import * as subscriptions from '@/runtime/runtime-rpc-subscribe'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SessionInlineDetails } from './AiVaultSessionDetails'
import { SessionAccountSection } from './AiVaultSessionAccount'
import { useAiVaultSessionAccount } from './ai-vault-session-account'
import { aiVaultSearchHitToSession } from './ai-vault-search-session'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
const originalStore = useAppStore.getState()
beforeEach(() => {
  vi.stubGlobal('api', {
    aiVault: { getFirstUserPrompt: vi.fn().mockResolvedValue({ prompt: null }) }
  })
})
afterEach(() => {
  cleanup()
  useAppStore.setState(originalStore, true)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function accountSettings(size = 1) {
  return {
    ...getDefaultSettings('/session-account-render'),
    activeClaudeManagedAccountId: 'different-selection',
    activeCodexManagedAccountId: 'different-selection',
    claudeManagedAccounts: Array.from({ length: size }, (_, index) => ({
      id: `claude-${index}`,
      email: `claude-${index}@example.com`,
      managedAuthPath: `/accounts/claude-${index}`,
      authMethod: 'unknown' as const,
      createdAt: 1,
      updatedAt: 1,
      lastAuthenticatedAt: 1
    })),
    codexManagedAccounts: Array.from({ length: size }, (_, index) => ({
      id: `codex-${index}`,
      email: `codex-${index}@example.com`,
      managedHomePath: `/accounts/codex-${index}`,
      createdAt: 1,
      updatedAt: 1,
      lastAuthenticatedAt: 1
    }))
  }
}

function recordedSession(agent: 'claude' | 'codex', index = 0): AiVaultSession {
  return {
    ...aiVaultSearchHitToSession(searchHit(), 'local'),
    id: `${agent}-${index}`,
    agent,
    accountHome: {
      variable: agent === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME',
      path: `/accounts/${agent}-${index}`
    }
  }
}

function details(sessions: AiVaultSession[]) {
  const resume = vi.fn()
  const panel = render(
    <TooltipProvider>
      {sessions.map((session) => (
        <div key={session.id} data-testid={session.id}>
          <SessionInlineDetails
            id={`details-${session.id}`}
            session={session}
            vaultScope="all"
            worktreeInfo={{ status: 'active', label: 'feature', path: '/repo/feature' }}
            resumeActions={{
              worktree: { worktreeId: null, disabled: true },
              newTab: { worktreeId: 'repo', disabled: false }
            }}
            onResumeInWorktree={resume}
            onResumeInNewTab={resume}
          />
        </div>
      ))}
    </TooltipProvider>
  )
  const account = (id: string) => {
    const card = panel.getByTestId(id)
    const section = within(card).getByText('Account').closest('section')
    if (!section) {
      throw new Error('Missing Account section')
    }
    expect(section.previousElementSibling?.textContent).toContain('Worktree')
    return within(section)
  }
  const unknown = (id: string) => {
    expect(account(id).getByText('Unknown').className).toContain('text-muted-foreground')
    resume.mockClear()
    fireEvent.click(
      within(panel.getByTestId(id)).getByRole('button', { name: 'Resume in New Tab' })
    )
    expect(resume).toHaveBeenCalledTimes(1)
  }
  return { ...panel, account, unknown }
}

it.each([2, 20])('isolates settings publications across %i local account cards', async (count) => {
  const original = useAppStore.getState()
  const directorySize = 100
  const settings = accountSettings(directorySize)
  let snapshot = {
    claude: { accounts: settings.claudeManagedAccounts, activeAccountId: null },
    codex: providerAccounts.emptyCodexAccountsState(),
    rateLimits: null
  }
  const fetchAccounts = vi
    .spyOn(providerAccounts, 'fetchProviderAccountsSnapshot')
    .mockImplementation(async () => snapshot)
  const comparisons = vi.spyOn(runtimePaths, 'normalizeRuntimePathForComparison')
  const local: AiVaultSession[] = Array.from({ length: count }, (_, index) => ({
    ...recordedSession(index % 2 === 0 ? 'claude' : 'codex', directorySize - 1),
    id: `local-${index}`
  }))
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

    snapshot = {
      ...snapshot,
      claude: {
        ...snapshot.claude,
        accounts: snapshot.claude.accounts.map((account) => ({
          ...account,
          email: 'updated@example.com'
        }))
      }
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

it('requires successful Claude roster evidence while keeping details and actions usable', async () => {
  const settings = accountSettings()
  const saved = settings.claudeManagedAccounts[0]!
  const older = {
    claude: { accounts: [{ ...saved, email: 'older@example.com' }], activeAccountId: 'another' },
    codex: providerAccounts.emptyCodexAccountsState(),
    rateLimits: null
  }
  const modern = {
    ...older,
    claude: {
      ...older.claude,
      accounts: [{ ...saved, home: '/profiles/current', email: 'current@example.com' }]
    }
  }
  const delayed = Promise.withResolvers<providerAccounts.ProviderAccountsSnapshot>()
  const fetchAccounts = vi
    .spyOn(providerAccounts, 'fetchProviderAccountsSnapshot')
    .mockReturnValue(delayed.promise)
  useAppStore.setState({ settings })
  const stale = recordedSession('claude')
  const current = {
    ...stale,
    id: 'current',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/profiles/current' }
  }
  const panel = details([stale, current, { ...stale, id: 'old-response', accountHome: undefined }])
  panel.unknown(stale.id)
  panel.unknown('current')
  panel.unknown('old-response')
  await act(async () => delayed.resolve(modern))
  panel.unknown(stale.id)
  expect(panel.account('current').getByText('current@example.com')).toBeTruthy()

  for (const result of [
    new Error('roster unavailable'),
    { ...older, failedProviders: ['claude' as const] },
    { ...older, claude: providerAccounts.emptyClaudeAccountsState() },
    older
  ]) {
    if (result instanceof Error) {
      fetchAccounts.mockRejectedValue(result)
    } else {
      fetchAccounts.mockResolvedValue(result)
    }
    await act(async () =>
      useAppStore.setState({
        settings: { ...settings, claudeManagedAccounts: [...settings.claudeManagedAccounts] }
      })
    )
    if (result === older) {
      expect(panel.account(stale.id).getByText('older@example.com')).toBeTruthy()
    } else {
      panel.unknown(stale.id)
    }
  }
})

it.each([2, 20])(
  'refreshes %i still-mounted recorded profiles on existing account-stream frames',
  async (count) => {
    const settings = accountSettings()
    useAppStore.setState({ settings })
    const profile = {
      id: '019fd532-7c11-7a90-b6de-4e1a2c3d5f60',
      label: 'Work',
      integrations: [],
      createdAt: 1
    }
    let snapshot = { opencode: { accounts: [profile], activeAccountId: 'another' } }
    const read = vi.spyOn(rpc, 'callRuntimeRpc').mockImplementation(async () => snapshot)
    const listeners = new Set<subscriptions.RuntimeRpcSubscriptionHandlers>()
    const close = vi.fn()
    const subscribe = vi
      .spyOn(subscriptions, 'subscribeRuntimeRpc')
      .mockImplementation(async (_target, _method, _params, handlers) => {
        listeners.add(handlers)
        handlers.onEvent({ type: 'ready', snapshot })
        return {
          unsubscribe: () => {
            listeners.delete(handlers)
            close()
          }
        }
      })
    const sessions: AiVaultSession[] = Array.from({ length: count }, (_, index) => ({
      ...recordedSession('claude'),
      id: `profile-${index}`,
      agent: 'opencode',
      accountHome: { kind: 'opencode', locator: { kind: 'managed', managedProfileId: profile.id } }
    }))
    const panel = details(sessions)
    await act(async () => {
      await Promise.resolve()
    })
    expect(subscribe).toHaveBeenCalledTimes(count)
    expect(subscribe).toHaveBeenCalledWith(
      { kind: 'local' },
      'accounts.subscribe',
      null,
      expect.any(Object)
    )
    expect(read).toHaveBeenCalledTimes(count)
    expect(read).toHaveBeenCalledWith({ kind: 'local' }, 'accounts.listData')
    for (const session of sessions) {
      expect(panel.account(session.id).getByText('Work')).toBeTruthy()
    }
    snapshot = { opencode: { accounts: [], activeAccountId: 'another' } }
    await act(async () => {
      listeners.forEach((listener) => listener.onEvent({ type: 'snapshot', snapshot }))
    })
    for (const session of sessions) {
      panel.unknown(session.id)
    }
    expect(read).toHaveBeenCalledTimes(2 * count)
    snapshot = { opencode: { accounts: [profile], activeAccountId: 'another' } }
    await act(async () => {
      listeners.forEach((listener) => listener.onEvent({ type: 'snapshot', snapshot }))
    })
    for (const session of sessions) {
      expect(panel.account(session.id).getByText('Work')).toBeTruthy()
    }
    expect(read).toHaveBeenCalledTimes(3 * count)
    await act(async () => {
      listeners.forEach((listener) => listener.onError(new Error('stream failed')))
    })
    for (const session of sessions) {
      panel.unknown(session.id)
    }
    expect(useAppStore.getState().settings?.claudeManagedAccounts).toBe(
      settings.claudeManagedAccounts
    )
    expect(useAppStore.getState().settings?.codexManagedAccounts).toBe(
      settings.codexManagedAccounts
    )
    panel.unmount()
    expect(close).toHaveBeenCalledTimes(count)
  }
)
