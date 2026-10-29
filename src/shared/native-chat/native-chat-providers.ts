// Persist explicit choices only; an agent without a saved chat choice opens as its CLI.

import type { GlobalSettings } from '../global-settings-types'
import type { TuiAgent } from '../tui-agent'
import { isStructuredAgentId } from '../agent-session-provider-handle-encoding'
import { TUI_AGENT_CONFIG } from '../tui-agent-config'

export type NativeChatProviderChoices = Partial<Record<string, boolean>>

export type NativeChatProviderSettings = Pick<GlobalSettings, 'nativeChatProviders'>

export function normalizeNativeChatProviderChoices(value: unknown): NativeChatProviderChoices {
  const choices: NativeChatProviderChoices = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return choices
  }
  for (const [agent, on] of Object.entries(value)) {
    if (isStructuredAgentId(agent) && typeof on === 'boolean') {
      choices[agent] = on
    }
  }
  return choices
}

export function buildNativeChatProviderUpdate(
  settings: Partial<NativeChatProviderSettings> | null | undefined,
  agent: TuiAgent,
  on: boolean
): Pick<GlobalSettings, 'nativeChatProviders'> {
  return {
    nativeChatProviders: {
      ...normalizeNativeChatProviderChoices(settings?.nativeChatProviders),
      [agent]: on
    }
  }
}

/**
 * The choices that keep what a profile's launches opened while Chat UI was experimental. With the
 * switch on, agents without a saved choice opened as chats, so they keep chat. With it off, every
 * launch opened its CLI, and the switch masked saved chat choices, so those turn CLI.
 */
export function carriedNativeChatProviderChoices(
  savedChoices: unknown,
  chatUiOn: boolean
): Record<string, boolean> {
  const saved: Record<string, boolean> = {}
  if (savedChoices && typeof savedChoices === 'object' && !Array.isArray(savedChoices)) {
    for (const [agent, on] of Object.entries(savedChoices)) {
      if (typeof on === 'boolean') {
        saved[agent] = chatUiOn && on
      }
    }
  }
  return chatUiOn
    ? {
        ...Object.fromEntries(Object.keys(TUI_AGENT_CONFIG).map((agent) => [agent, true])),
        ...saved
      }
    : saved
}
