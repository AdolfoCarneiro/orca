import { useMemo } from 'react'
import { useNow } from '../../../hooks/use-now'
import type { MobileSessionTab } from '../../mobile-session-route-types'
import { MobileAgentMessageContext, mobileAgentMessageTabs } from './mobile-agent-message-context'

export function MobileAgentMessageProvider({
  tabs,
  open,
  children
}: {
  tabs: readonly MobileSessionTab[]
  open?: NonNullable<React.ContextType<typeof MobileAgentMessageContext>>['open']
  children: React.ReactNode
}) {
  const tabsBySender = useMemo(() => mobileAgentMessageTabs(tabs), [tabs])
  const now = useNow(60_000)
  const value = useMemo(() => ({ tabsBySender, now, open }), [tabsBySender, now, open])
  return (
    <MobileAgentMessageContext.Provider value={value}>
      {children}
    </MobileAgentMessageContext.Provider>
  )
}
