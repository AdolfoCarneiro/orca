// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { projectAgentLaunchSettings } from '../../../../shared/agent-launch-settings'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { ManagedRuntimeInstallObservation } from '@/runtime/use-managed-runtime-install'
import type * as SignInAreaModule from './AntigravityProviderSignInArea'
import { TooltipProvider } from '../ui/tooltip'
import { AgentCatalogRow } from './AgentCatalogRow'
import { AgentChatRuntimeArea } from './AgentChatChoiceControls'
import { AgentLaunchSettingsCatalog } from './AgentLaunchSettingsCatalog'
import { buildAgentOpensAs } from './native-chat-provider-choice'

const store = vi.hoisted((): { settings: unknown } => ({ settings: null }))
const runtime = vi.hoisted((): { current: ManagedRuntimeInstallObservation } => ({
  current: { kind: 'pending' }
}))
vi.mock('../../store', () => ({
  useAppStore: Object.assign((selector: (value: unknown) => unknown) => selector(store), {
    getState: () => store
  })
}))
vi.mock('@/lib/chat-provider-agents', () => ({
  chatProviderAgents: () => ['claude', 'codex', 'antigravity'],
  useHostStructuredAgentsVersion: () => 0
}))
vi.mock('@/hooks/useDetectedAgents', () => ({
  useDetectedAgents: () => ({
    detectedIds: ['claude'],
    detectionFailed: false,
    isRefreshing: false,
    refresh: vi.fn()
  })
}))
vi.mock('@/lib/host-chat-program-acquisition', () => ({ useChatProgramFacts: () => {} }))
vi.mock('@/lib/host-chat-program', () => ({
  agentChoiceOpensAsChat: () => false,
  resolveChatProgramContext: () => ({}),
  // The host publishes Antigravity's downloaded chat program; its agy CLI is not installed.
  readChatProgram: (_store: unknown, agent: string) =>
    agent === 'antigravity' ? 'available' : 'missing'
}))
vi.mock('@/runtime/use-managed-runtime-install', () => ({
  useManagedRuntimeInstall: () => runtime.current
}))
vi.mock('./AntigravityChatSignInRow', () => ({ useAntigravityChatSignIn: () => ({ flow: null }) }))
vi.mock('./AntigravityProviderSignInArea', async (importOriginal) => ({
  ...(await importOriginal<typeof SignInAreaModule>()),
  AntigravityProviderSignInArea: () => <p>Antigravity account</p>
}))
afterEach(cleanup)

function renderRow(
  agent: TuiAgent,
  settings: ReturnType<typeof createGlobalSettingsFixture>,
  cliDetected: boolean,
  chatRuntime?: React.ReactNode
) {
  const updateSettings = vi.fn()
  store.settings = settings
  const label = agent === 'antigravity' ? 'Antigravity' : agent === 'codex' ? 'Codex' : 'Claude'
  render(
    <AgentCatalogRow
      agentId={agent}
      label={label}
      homepageUrl="https://example.com"
      defaultCmd={agent}
      defaultArgs=""
      defaultEnv={{}}
      isDetected={cliDetected}
      isEnabled
      isDefault={false}
      cmdOverride={undefined}
      argsOverride=""
      envOverride={{}}
      onSetDefault={vi.fn()}
      onSetEnabled={vi.fn()}
      onSaveOverride={vi.fn()}
      onSaveArgs={vi.fn()}
      onSaveEnv={vi.fn()}
      opensAs={buildAgentOpensAs({
        agent,
        cliDetected,
        chatProgramHere: !cliDetected,
        settings,
        updateSettings
      })}
      chatRuntime={chatRuntime}
    />,
    { wrapper: TooltipProvider }
  )
  return updateSettings
}

const checked = (name: string): string | null | undefined =>
  screen.getByRole('radiogroup', { name }).querySelector('[aria-checked="true"]')?.textContent

describe('agent row chat or CLI', () => {
  it("shows and writes the agent's own chat choice, the one launches and the + menu read", async () => {
    const settings = createGlobalSettingsFixture({
      experimentalNativeChat: true,
      nativeChatProviders: { codex: false }
    })
    const updateSettings = renderRow('claude', settings, true)
    // Unchosen agents open as a chat, so the row says Chat.
    expect(checked('Open Claude as')).toBe('Chat')
    fireEvent.click(screen.getByRole('radio', { name: 'CLI' }))
    await vi.waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({
        nativeChatProviders: { codex: false, claude: false }
      })
    )
    cleanup()
    renderRow('codex', settings, true)
    expect(checked('Open Codex as')).toBe('CLI')
  })

  it('offers only Chat for an agent whose chat runs without its CLI', () => {
    const updateSettings = renderRow(
      'antigravity',
      createGlobalSettingsFixture({ experimentalNativeChat: true }),
      false
    )
    expect(checked('Open Antigravity as')).toBe('Chat')
    const cli = screen.getByRole('radio', { name: 'CLI' })
    expect(cli.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(cli)
    expect(updateSettings).not.toHaveBeenCalled()
    // It is installed for chat, so the row is not dimmed like an uninstalled agent.
    expect(document.querySelector('.opacity-70')).toBeNull()
  })

  it('offers no choice while Chat UI is off or the agent is turned off', () => {
    renderRow('claude', createGlobalSettingsFixture({ experimentalNativeChat: false }), true)
    expect(screen.queryByRole('radiogroup', { name: 'Open Claude as' })).toBeNull()
    cleanup()
    renderRow(
      'claude',
      createGlobalSettingsFixture({ experimentalNativeChat: true, disabledTuiAgents: ['claude'] }),
      true
    )
    expect(screen.queryByRole('radiogroup', { name: 'Open Claude as' })).toBeNull()
  })

  it("shows Antigravity's downloaded chat runtime and chat sign-in in its row", () => {
    runtime.current = {
      kind: 'active',
      subject: { target: { kind: 'local' }, runtimeId: null, agent: 'antigravity' },
      removable: true,
      snapshot: {
        kind: 'known',
        state: {
          agent: 'antigravity',
          revision: 1,
          available: true,
          version: '1',
          installedVersion: '1',
          installedCurrent: true,
          operation: null,
          source: 'managed'
        }
      }
    }
    renderRow(
      'antigravity',
      createGlobalSettingsFixture({ experimentalNativeChat: true }),
      false,
      <AgentChatRuntimeArea agent="antigravity" label="Antigravity" />
    )
    expect(screen.queryByText('Chat runtime')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Expand agent settings' }))
    expect(screen.getByText('Chat runtime')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toContain('Installed')
    expect(screen.getByText('Antigravity account')).toBeTruthy()
  })

  it('lists an agent whose chat runs without its CLI as installed, with Chat only', () => {
    vi.stubGlobal('api', { platform: { get: () => ({ platform: 'darwin' }) } })
    const settings = createGlobalSettingsFixture({ experimentalNativeChat: true })
    store.settings = settings
    render(
      <AgentLaunchSettingsCatalog
        settings={projectAgentLaunchSettings(settings, 'darwin')}
        mutate={vi.fn(async () => {})}
        detectionTarget={{ kind: 'local' }}
        hostName={null}
        renderPermissions={() => null}
        local={{ settings, updateSettings: vi.fn(), saveEnvironment: vi.fn(async () => {}) }}
      />,
      { wrapper: TooltipProvider }
    )
    const installed = document.getElementById('agents-installed')
    expect(installed?.textContent).toContain('Antigravity')
    expect(checked('Open Antigravity as')).toBe('Chat')
    const group = screen.getByRole('radiogroup', { name: 'Open Antigravity as' })
    expect(group.querySelector('[aria-checked="false"]')?.getAttribute('aria-disabled')).toBe(
      'true'
    )
    expect(checked('Open Claude as')).toBe('Chat')
    expect(screen.queryByRole('radiogroup', { name: 'Open Codex as' })).toBeNull()
    vi.unstubAllGlobals()
  })
})
