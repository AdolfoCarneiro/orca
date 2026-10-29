// Persist explicit choices only; launches route unchosen agents to chat and Settings enables installed non-built-ins.

import { isAgentSessionHandleProvider } from '../agent-session-provider-handle'
import type { GlobalSettings } from '../global-settings-types'
import type { TuiAgent } from '../tui-agent'
import { isTuiAgent, TUI_AGENT_CONFIG } from '../tui-agent-config'

export type NativeChatProviderChoices = Partial<Record<TuiAgent, boolean>>

export type NativeChatProviderSettings = Pick<GlobalSettings, 'nativeChatProviders'>

export function normalizeNativeChatProviderChoices(value: unknown): NativeChatProviderChoices {
  const choices: NativeChatProviderChoices = {}
  if (!value || typeof value !== 'object') {
    return choices
  }
  for (const [agent, on] of Object.entries(value)) {
    if (isTuiAgent(agent) && typeof on === 'boolean') {
      choices[agent] = on
    }
  }
  return choices
}

/** The switch's displayed value, independent of launch feasibility. */
export function isNativeChatProviderDisplayedOn(
  settings: Partial<NativeChatProviderSettings> | null | undefined,
  agent: TuiAgent,
  installedHere: readonly TuiAgent[] | null
): boolean {
  return (
    settings?.nativeChatProviders?.[agent] ??
    (isAgentSessionHandleProvider(agent) || installedHere?.includes(agent) === true)
  )
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
 * CLI for every agent known now and every agent the profile already chose for. Keeps launches on
 * the terminal for a profile whose Chat UI was off when it left Experimental; the old switch masked
 * saved chat choices, so those turn CLI too.
 */
export function terminalNativeChatProviderChoices(savedChoices: unknown): Record<string, false> {
  const saved =
    savedChoices && typeof savedChoices === 'object' && !Array.isArray(savedChoices)
      ? Object.keys(savedChoices)
      : []
  return Object.fromEntries(
    [...new Set([...Object.keys(TUI_AGENT_CONFIG), ...saved])].map((agent) => [agent, false])
  )
}
