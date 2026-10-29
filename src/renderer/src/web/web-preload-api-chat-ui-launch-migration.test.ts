import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import { installBrowserGlobals } from './web-preload-api-test-harness'

const SETTINGS_KEY = 'orca.web.settings.v1'

async function loadSettings(stored: Record<string, unknown> | null) {
  const globals = installBrowserGlobals('Linux')
  if (stored) {
    globals.storage.setItem(SETTINGS_KEY, JSON.stringify(stored))
  }
  const { installWebPreloadApi } = await import('./web-preload-api')
  installWebPreloadApi()
  const settings = await globals.window.api.settings.get()
  const saved = JSON.parse(globals.storage.getItem(SETTINGS_KEY) ?? '{}') as Record<string, unknown>
  return { settings, saved, globals }
}

describe('web Chat UI launch migration', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps every agent on the terminal for a browser profile saved with Chat UI off, once', async () => {
    const { settings, saved, globals } = await loadSettings({
      experimentalNativeChat: false,
      nativeChatProviders: { claude: true }
    })

    expect(settings.nativeChatProviders).toEqual(
      Object.fromEntries(Object.keys(TUI_AGENT_CONFIG).map((agent) => [agent, false]))
    )
    expect(saved).not.toHaveProperty('experimentalNativeChat')
    expect(saved.nativeChatProviders).toEqual(settings.nativeChatProviders)

    // The dropped key is the run-once marker: a later chat choice survives the next load.
    globals.storage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ ...saved, nativeChatProviders: { claude: true } })
    )
    vi.resetModules()
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()
    expect((await globals.window.api.settings.get()).nativeChatProviders).toEqual({ claude: true })
  })

  it('drops the switch without writing choices for a browser profile saved with Chat UI on', async () => {
    const { settings, saved } = await loadSettings({
      experimentalNativeChat: true,
      nativeChatProviders: { codex: false }
    })

    expect(settings.nativeChatProviders).toEqual({ codex: false })
    expect(saved).not.toHaveProperty('experimentalNativeChat')
  })

  it('writes nothing for a browser profile without the switch', async () => {
    const { settings } = await loadSettings({ theme: 'dark' })

    expect(settings.nativeChatProviders).toBeUndefined()
  })
})
