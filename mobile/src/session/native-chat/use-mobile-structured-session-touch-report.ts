import { useCallback, useEffect, useState } from 'react'
import { AppState } from 'react-native'
import { useFocusEffect } from 'expo-router'
import type { MobileNativeChatVisualSource } from './visual/mobile-native-chat-visual-read'

/** Report when the user sees this chat at rest: it comes on screen idle and read, or its turn ends on screen.
 *  A reconnect re-reads the chat, so a report lost to a dropped connection is sent again.
 *  The owning host keeps a finished worker's chat on such a report instead of closing it. */
export function useMobileStructuredSessionTouchReport(
  source: MobileNativeChatVisualSource | null,
  shown: boolean,
  atRest: boolean
): void {
  const [focused, setFocused] = useState(false)
  useFocusEffect(
    useCallback(() => {
      setFocused(true)
      return () => setFocused(false)
    }, [])
  )
  const [appActive, setAppActive] = useState(AppState.currentState === 'active')
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) =>
      setAppActive(state === 'active')
    )
    return () => subscription.remove()
  }, [])
  const seenAtRest = shown && focused && appActive && atRest
  const client = source?.client
  const sessionId = source?.sessionId
  useEffect(() => {
    if (seenAtRest && client && sessionId) {
      void client
        .sendRequest(
          'orchestration.workerChatTouch',
          { sessionId },
          { timeoutMs: 5_000, budgetSpansConnect: true, failWhenDisconnected: true }
        )
        .catch(() => {})
    }
  }, [seenAtRest, client, sessionId])
}
