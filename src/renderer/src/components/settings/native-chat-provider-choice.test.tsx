// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import { AgentDefaultSetting } from './AgentDefaultSetting'
import {
  saveNativeChatProviderChoice,
  buildDefaultAgentOpensAs
} from './native-chat-provider-choice'

const store = vi.hoisted((): { settings: unknown } => ({ settings: null }))
vi.mock('../../store', () => ({ useAppStore: { getState: () => store } }))
afterEach(cleanup)

function renderDefault(settings: ReturnType<typeof createGlobalSettingsFixture>) {
  const updateSettings = vi.fn()
  store.settings = settings
  render(
    <AgentDefaultSetting
      defaultAgent={settings.defaultTuiAgent}
      detectedIds={new Set(['claude'])}
      enabledDetectedAgents={[]}
      catalog={[]}
      description=""
      opensAs={buildDefaultAgentOpensAs({
        defaultAgent: settings.defaultTuiAgent,
        settings,
        updateSettings,
        installedHere: ['claude']
      })}
      onSetDefault={vi.fn()}
    />
  )
  return updateSettings
}

describe('default agent chat or CLI', () => {
  it("flips the default agent's own chat switch, the one Providers and the + menu read", async () => {
    const updateSettings = renderDefault(
      createGlobalSettingsFixture({
        defaultTuiAgent: 'claude',
        nativeChatProviders: { codex: false, claude: true }
      })
    )
    const group = screen.getByRole('radiogroup', { name: 'Open Claude as' })
    expect(group.querySelector('[aria-checked="true"]')?.textContent).toBe('Chat')
    fireEvent.click(screen.getByRole('radio', { name: 'CLI' }))
    await vi.waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({
        nativeChatProviders: { codex: false }
      })
    )
  })

  it('reads an agent without a saved choice as CLI', () => {
    renderDefault(createGlobalSettingsFixture({ defaultTuiAgent: 'claude' }))
    const group = screen.getByRole('radiogroup', { name: 'Open Claude as' })
    expect(group.querySelector('[aria-checked="true"]')?.textContent).toBe('CLI')
  })
})

it.each(['chat', 'terminal'] as const)(
  'stores only opposite overrides to default %s and retains saved IDs',
  async (agentDefaultSurface) => {
    const settings = createGlobalSettingsFixture({
      agentDefaultSurface,
      nativeChatProviders: { 'saved-agent': true, codex: false }
    })
    store.settings = settings
    const updateSettings = vi.fn()
    const write = (on: boolean) =>
      saveNativeChatProviderChoice({
        agent: 'claude',
        on,
        fallbackSettings: settings,
        updateSettings
      })
    await write(agentDefaultSurface !== 'chat')
    expect(updateSettings).toHaveBeenLastCalledWith({
      nativeChatProviders: {
        'saved-agent': true,
        codex: false,
        claude: agentDefaultSurface !== 'chat'
      }
    })
    await write(agentDefaultSurface === 'chat')
    expect(updateSettings).toHaveBeenLastCalledWith({
      nativeChatProviders: { 'saved-agent': true, codex: false }
    })
  }
)
