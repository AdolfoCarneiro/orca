import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EVERY_AGENT_CHAT } from '../../../shared/native-chat/every-agent-chat.test-fixture'
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

  it('turns chat choices the switch masked to CLI for a browser profile saved with Chat UI off, once', async () => {
    const { settings, saved, globals } = await loadSettings({
      experimentalNativeChat: false,
      nativeChatProviders: { claude: true, codex: false }
    })

    expect(settings.nativeChatProviders).toEqual({ claude: false, codex: false })
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

  it('keeps agents without a choice on chat for a browser profile saved with Chat UI on', async () => {
    const { settings, saved } = await loadSettings({
      experimentalNativeChat: true,
      nativeChatProviders: { codex: false }
    })

    expect(settings.nativeChatProviders).toEqual({ ...EVERY_AGENT_CHAT, codex: false })
    expect(saved).not.toHaveProperty('experimentalNativeChat')
  })

  it('writes nothing for a browser profile without the switch', async () => {
    const { settings } = await loadSettings({ theme: 'dark' })

    expect(settings.nativeChatProviders).toBeUndefined()
  })
})
