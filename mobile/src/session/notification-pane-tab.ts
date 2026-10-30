import { parsePaneKey } from '../../../src/shared/stable-pane-id'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../src/shared/structured-agent-session-projection'
import type { MobileSessionTab } from './mobile-session-route-types'

// Keep native/web navigation’s pane lookup separate: importing the native sibling by name on web resolves back to the web file itself.
export function notificationPaneTab(tabs: readonly MobileSessionTab[], paneKey: string) {
  const chat = tabs.find(
    (tab) =>
      tab.type === 'agent-session' &&
      (structuredAgentSessionPaneKey(tab.id, tab.sessionId) === paneKey ||
        structuredAgentSessionPaneKey(structuredAgentSessionTabId(tab.sessionId), tab.sessionId) ===
          paneKey)
  )
  if (chat) {
    return chat
  }
  const pane = parsePaneKey(paneKey)
  if (!pane) {
    return undefined
  }
  return tabs.find(
    (tab) =>
      tab.type === 'terminal' &&
      (tab.parentTabId ?? tab.id) === pane.tabId &&
      tab.leafId === pane.leafId
  )
}
