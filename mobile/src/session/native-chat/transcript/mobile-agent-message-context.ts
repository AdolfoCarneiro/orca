import { createContext } from 'react'
import type { MobileSessionTab } from '../../mobile-session-route-types'
import type { AgentMessageSource } from '../../../../../src/shared/agent-session/agent-session-message-source'

export const MobileAgentMessageContext = createContext<{
  tabsBySender: ReadonlyMap<string, MobileSessionTab>
  now: number
  open?: (from: AgentMessageSource, sender: AgentMessageSource['senders'][number]) => void
}>({ tabsBySender: new Map(), now: 0 })

export function mobileAgentMessageTabs(tabs: readonly MobileSessionTab[]) {
  const index = new Map<string, MobileSessionTab>()
  for (const tab of tabs) {
    if (tab.type === 'agent-session') {
      index.set(tab.sessionId, tab)
    } else if (tab.type === 'terminal' && tab.terminal) {
      index.set(tab.terminal, tab)
    }
  }
  return index
}
