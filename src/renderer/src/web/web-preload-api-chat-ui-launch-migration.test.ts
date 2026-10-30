import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EVERY_AGENT_CHAT } from '../../../shared/native-chat/every-agent-chat.test-fixture'
import { nativeChatPreferenceFor } from '../../../shared/structured-native-chat-launch-route'
import {
  installBrowserGlobals,
  writeStoredRuntimeEnvironment
} from './web-preload-api-test-harness'

const SETTINGS_KEY = 'orca.web.settings.v1'

async function loadSettings(stored: Record<string, unknown> | null) {
  const globals = installBrowserGlobals('Linux')
  if (stored) {
    globals.storage.setItem(SETTINGS_KEY, JSON.stringify(stored))
  }
  const { installWebPreloadApi } = await import('./web-preload-api')
  installWebPreloadApi()
  const settings = await globals.window.api.settings.get()
  const saved: Record<string, unknown> = JSON.parse(globals.storage.getItem(SETTINGS_KEY) ?? '{}')
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

const oldHost = vi.hoisted(() => {
  const calls: string[] = []
  return { on: false, fail: false, calls }
})
vi.mock('./web-runtime-client', () => ({
  WebRuntimeClient: class {
    async call(method: string) {
      oldHost.calls.push(method)
      if (oldHost.fail) {
        throw new Error('offline')
      }
      return {
        id: method,
        ok: true,
        _meta: { runtimeId: 'released-host' },
        result: {
          settings: {
            experimentalNativeChat: oldHost.on,
            experimentalStructuredNativeChat: oldHost.on,
            openAgentTabsInChatByDefault: false,
            nativeChatProviders: { claude: oldHost.on, codex: oldHost.on },
            compactWorktreeCards: true,
            minimaxGroupId: 'live-host-group'
          }
        }
      }
    }
    close() {}
  }
}))

it.each([
  { name: 'upgraded on', stored: { experimentalNativeChat: true }, expected: true },
  { name: 'upgraded off', stored: { experimentalNativeChat: false }, expected: false },
  { name: 'fresh', stored: {}, expected: false }
])(
  'keeps $name browser choices through old-host responses, edits, offline and reopen',
  async ({ stored, expected }) => {
    for (const hostOn of [false, true]) {
      vi.resetModules()
      oldHost.on = hostOn
      oldHost.fail = false
      oldHost.calls = []
      const { globals, settings: initial } = await loadSettings(stored)
      expect(nativeChatPreferenceFor(initial, 'claude')).toBe(expected)
      writeStoredRuntimeEnvironment(globals.storage)
      // Reinstall so the real API reads its now-paired host from storage.
      vi.resetModules()
      const { installWebPreloadApi } = await import('./web-preload-api')
      installWebPreloadApi()
      const check = (
        settings: Awaited<ReturnType<typeof globals.window.api.settings.get>>,
        choice: boolean
      ) => {
        expect(nativeChatPreferenceFor(settings, 'claude')).toBe(choice)
        expect(nativeChatPreferenceFor(settings, 'new-agent')).toBe(false)
        const saved = JSON.parse(globals.storage.getItem(SETTINGS_KEY) ?? '{}')
        for (const key of [
          'experimentalNativeChat',
          'experimentalStructuredNativeChat',
          'openAgentTabsInChatByDefault'
        ]) {
          expect(settings).not.toHaveProperty(key)
          expect(saved).not.toHaveProperty(key)
        }
        expect(saved.nativeChatProviders).toEqual(settings.nativeChatProviders)
      }
      for (const [stage, choice] of [expected, true, false].entries()) {
        if (stage > 0) {
          await globals.window.api.settings.set({ nativeChatProviders: { claude: choice } })
        }
        for (let iteration = 0; iteration < 2; iteration++) {
          const returned = await globals.window.api.settings.set({ compactWorktreeCards: false })
          check(returned, choice)
          expect(returned.compactWorktreeCards).toBe(true)
          expect(returned.minimaxGroupId).toBe('live-host-group')
          check(await globals.window.api.settings.get(), choice)
          vi.resetModules()
          const reopened = await import('./web-preload-api')
          reopened.installWebPreloadApi()
          check(await globals.window.api.settings.get(), choice)
        }
        oldHost.fail = true
        check(await globals.window.api.settings.set({ compactWorktreeCards: false }), choice)
        check(await globals.window.api.settings.get(), choice)
        oldHost.fail = false
      }
      expect(oldHost.calls).toContain('settings.update')
      expect(oldHost.calls).toContain('settings.get')
    }
  }
)
