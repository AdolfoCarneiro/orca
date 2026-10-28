import { useRef } from 'react'
import type { ScrollView, TextInput } from 'react-native'

// Keep a focused reply in view when its card shrinks above the keyboard.
export function useMobileNativeChatReplyScroll() {
  const scrollRef = useRef<ScrollView>(null)
  const inputRef = useRef<TextInput>(null)
  const revealReply = (): void => {
    if (inputRef.current?.isFocused()) {
      scrollRef.current?.scrollToEnd({ animated: false })
    }
  }
  return { scrollRef, inputRef, revealReply }
}
