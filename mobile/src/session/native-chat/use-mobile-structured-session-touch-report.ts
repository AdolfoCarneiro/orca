import { useEffect } from 'react'
import type { MobileNativeChatVisualSource } from './visual/mobile-native-chat-visual-read'

/** Report when the user sees this chat: it comes on screen read, or its turn starts or ends on screen.
 *  Opening a working chat counts, since its worker may already have reported done.
 *  A reconnect re-reads the chat, so a report lost to a dropped connection is sent again.
 *  The owning host keeps a finished worker's chat on such a report instead of closing it. */
export function useMobileStructuredSessionTouchReport(
  source: MobileNativeChatVisualSource | null,
  shown: boolean,
  readable: boolean,
  working: boolean
): void {
  // Shown counts as seen even under another screen or a backgrounded app: keeping a chat is the safe error.
  const seen = shown && readable
  const client = source?.client
  const sessionId = source?.sessionId
  useEffect(() => {
    if (seen && client && sessionId) {
      void client
        .sendRequest(
          'orchestration.workerChatTouch',
          { sessionId },
          { timeoutMs: 5_000, budgetSpansConnect: true, failWhenDisconnected: true }
        )
        .catch(() => {})
    }
  }, [seen, working, client, sessionId])
}
