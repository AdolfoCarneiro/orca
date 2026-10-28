// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import {
  TEST_REPO,
  makeWorktree,
  makeTerminalTab
} from '@/store/slices/worktrees-slice-test-fixtures'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { CliChatResumeMenuItems } from '../tab-bar/CliChatResumeMenuItems'
import { TerminalPaneResumeInChatButton } from './TerminalPaneResumeInChatButton'
import { resolveCliChatResumeSource } from '../tab-bar/cli-chat-resume-source'
import { conversationSwitchFailureText } from '@/lib/conversation-switch-feedback'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { agentSessionRefusalError } from '../../../../shared/agent-session-wire-refusals'
vi.mock('@/runtime/local-runtime-capabilities', () => ({
  ensureLocalRuntimeCapabilities: async () => [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY],
  readLocalRuntimeCapabilitiesOrUnknown: () => [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY],
  subscribeLocalRuntimeCapabilityObservation: () => () => {}
}))
afterEach(cleanup)
it.each(['foreground', 'suspended'] as const)(
  'keeps the real Claude header/menu switchable during held %s work and after exit',
  (job) => {
    useAppStore.setState(useAppStore.getInitialState(), true)
    const paneKey = 'shell:3f2504e0-4f89-41d3-9a0c-0305e82c3301'
    useAppStore.setState({
      settings: createGlobalSettingsFixture({ experimentalNativeChat: true }),
      repos: [TEST_REPO],
      worktreesByRepo: { repo1: [makeWorktree({ id: 'wt-1', repoId: 'repo1' })] },
      tabsByWorktree: { 'wt-1': [makeTerminalTab({ id: 'shell', worktreeId: 'wt-1' })] },
      terminalLayoutsByTabId: {
        shell: {
          root: { type: 'leaf', leafId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' },
          activeLeafId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
          expandedLeafId: null,
          ptyIdsByLeafId: { '3f2504e0-4f89-41d3-9a0c-0305e82c3301': 'pty-1' }
        }
      }
    })
    useAppStore
      .getState()
      .recordAgentProviderSession(
        paneKey,
        'claude',
        { key: 'session_id', id: 'real-claude' },
        undefined,
        { worktreeId: 'wt-1', tabId: 'shell' }
      )
    useAppStore.getState().setPaneForegroundAgent(paneKey, {
      agent: 'claude',
      shellForeground: job === 'suspended',
      ...(job === 'suspended' ? { suspendedAgent: 'claude' as const } : {})
    })
    const source = resolveCliChatResumeSource(useAppStore.getState(), {
      tab: { id: 'shell', worktreeId: 'wt-1' },
      paneKey
    })
    expect(source).toMatchObject({ agent: 'claude', providerSessionId: 'real-claude' })
    render(
      <TooltipProvider>
        <TerminalPaneResumeInChatButton tabId="shell" worktreeId="wt-1" paneKey={paneKey} />
        <DropdownMenu open>
          <DropdownMenuTrigger>Menu</DropdownMenuTrigger>
          <DropdownMenuContent>
            <CliChatResumeMenuItems
              tab={{ id: 'shell', worktreeId: 'wt-1' }}
              leadingSeparator={false}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      </TooltipProvider>
    )
    const header = screen.getByRole('button', { name: 'Switch to native chat', hidden: true })
    expect(header.hasAttribute('disabled')).toBe(false)
    expect(
      screen.getByRole('menuitem', { name: 'Switch to native chat' }).getAttribute('aria-disabled')
    ).not.toBe('true')
    act(() =>
      useAppStore.getState().setPaneForegroundAgent(paneKey, { agent: null, shellForeground: true })
    )
    expect(header.hasAttribute('disabled')).toBe(false)
    expect(
      screen.getByRole('menuitem', { name: 'Switch to native chat' }).getAttribute('aria-disabled')
    ).not.toBe('true')
    expect(
      resolveCliChatResumeSource(useAppStore.getState(), {
        tab: { id: 'shell', worktreeId: 'wt-1' },
        paneKey
      })
    ).toEqual(source)
    const refusal = agentSessionRefusalError('agent_session_conflict', {
      reason: 'conversationHeldElsewhere',
      source: true
    })
    expect(
      conversationSwitchFailureText(refusal, { agent: 'claude', direction: 'chat', source })
    ).toBe(
      'Orca could not confirm Claude stopped in this terminal. Quit Claude here, then try this action again.'
    )
    expect(
      conversationSwitchFailureText(
        agentSessionRefusalError('agent_session_conflict', {
          reason: 'conversationHeldElsewhere'
        }),
        { agent: 'claude', direction: 'chat', source, history: {} }
      )
    ).toBe(
      'Orca could not confirm Claude stopped. Check its open chats and terminals, then try this action again.'
    )
    expect(
      conversationSwitchFailureText(
        agentSessionRefusalError('agent_session_conflict', {
          reason: 'conversationHeldElsewhere',
          owner: { sessionId: 'other', workspaceId: 'wt-1' }
        }),
        { agent: 'claude', direction: 'chat', source }
      )
    ).toBe('Claude is open in another chat or terminal. Continue there, then try switching again.')
  }
)

vi.mock('@/components/confirmation-dialog-context', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useConfirmationDialog: () => vi.fn(async () => false)
}))
