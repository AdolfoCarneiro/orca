import { describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../shared/constants'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { RuntimeStore } from '../runtime/runtime-store-contract'
import { decideAgentLaunchMode, readAgentLaunchModeSettings } from './agent-launch-mode'

vi.mock('electron', () => ({ app: { getPath: () => '/orca-state', isPackaged: true } }))

describe('host launch preference ownership', () => {
  it.each([false, true])('reads saved choices privately with Agents disabled=%s', (disabled) => {
    const settings: ReturnType<RuntimeStore['getSettings']> = {
      ...getDefaultSettings('/tmp'),
      nativeChatProviders: { claude: false },
      disabledTuiAgents: disabled ? ['claude'] : []
    }
    const store = { getSettings: () => settings }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: construction and these readers use only getSettings from the fixture.
    const runtime = new OrcaRuntimeService(store as RuntimeStore)
    expect(runtime.getClientSettings()).not.toHaveProperty('nativeChatProviders')
    const mode = decideAgentLaunchMode({
      placement: { agent: 'claude' },
      settings: readAgentLaunchModeSettings(runtime)
    })
    expect(mode.mode).toBe('terminal')
  })

  it('keeps an unchosen provider on without discovering installed agents', () => {
    const saved = {}
    const runtime = { requireStore: () => ({ getSettings: () => saved }) }
    expect(
      decideAgentLaunchMode({
        placement: { agent: 'grok' },
        settings: readAgentLaunchModeSettings(runtime)
      }).mode
    ).toBe('structured')
    expect(saved).not.toHaveProperty('nativeChatProviders')
  })

  it.each([false, true])('maps desktop stamp %s onto the launched agent only', (stamp) => {
    const runtime = {
      requireStore: () => ({
        getSettings: () => ({ nativeChatProviders: { grok: !stamp, claude: !stamp } })
      })
    }
    const settings = readAgentLaunchModeSettings(runtime, {
      agent: 'grok',
      nativeChatDefault: stamp
    })
    expect(settings).toEqual({ nativeChatProviders: { grok: stamp } })
    expect(decideAgentLaunchMode({ placement: { agent: 'grok' }, settings }).mode).toBe(
      stamp ? 'structured' : 'terminal'
    )
    // An explicit surface wins over the stamp.
    expect(
      decideAgentLaunchMode({
        placement: { agent: 'grok' },
        settings,
        surface: stamp ? 'terminal' : 'chat'
      }).mode
    ).toBe(stamp ? 'terminal' : 'structured')
  })
})
