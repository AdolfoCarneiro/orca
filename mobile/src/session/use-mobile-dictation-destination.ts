import { useCallback, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import {
  insertDictationText,
  type MobileDictationAnchor
} from '../dictation/mobile-dictation-text-insertion'
import {
  captureMobileNativeChatTextDestination,
  type MobileNativeChatDictationPreview,
  type MobileNativeChatTextDestination
} from './native-chat/composer/mobile-native-chat-draft-inputs'

type MobileDictationTarget =
  | { field: 'chat'; scope: string | null; anchor: MobileDictationAnchor | null }
  | { field: 'command'; anchor: MobileDictationAnchor | null }
  // Live terminal input: the words show on that terminal's status row.
  | { field: 'live'; handle: string }
  | null

// Terminals share one command field: a selection read in another terminal doesn't place this one's words.
export function commandFieldAnchorIn(
  saved: { handle: string | null; anchor: MobileDictationAnchor } | null,
  handle: string
): MobileDictationAnchor | null {
  return saved?.handle === handle ? saved.anchor : null
}

// Where a dictation's words go, read once when it starts: a chat composer, the terminal's command field, or live input.
export function useMobileDictationDestination(
  chatComposerScopeKey: string | null | undefined,
  setChatComposerText: Dispatch<SetStateAction<string>>
) {
  const chatRef = useRef<MobileNativeChatTextDestination | undefined>(undefined)
  const [target, setTarget] = useState<MobileDictationTarget>(null)
  const captureDestination = useCallback(
    (
      chatShown: boolean,
      terminal: {
        handle: string
        liveInputEnabled: boolean
        anchor: MobileDictationAnchor | null
      } | null
    ) => {
      const chat = captureMobileNativeChatTextDestination()
      chatRef.current = chat
      setTarget(
        chat || chatShown
          ? {
              field: 'chat',
              scope: chat ? chat.scope : (chatComposerScopeKey ?? null),
              anchor: chat?.anchor ?? null
            }
          : terminal?.liveInputEnabled
            ? { field: 'live', handle: terminal.handle }
            : { field: 'command', anchor: terminal?.anchor ?? null }
      )
    },
    [chatComposerScopeKey]
  )
  // The final text goes to the chat captured at start, or the end of the chat draft; false when that chat refused it.
  const insertInChat = useCallback(
    (text: string): boolean => {
      const chat = chatRef.current
      chatRef.current = undefined
      if (chat) {
        return chat.insert(text) !== false
      }
      setChatComposerText((current) => insertDictationText(current, text, null).text)
      return true
    },
    [setChatComposerText]
  )
  return {
    target,
    captureDestination,
    capturedChat: () => chatRef.current !== undefined,
    insertInChat
  }
}

// The words heard so far, drawn where the dictation's target will put them.
export function useMobileDictationPreviews(
  { target }: { target: MobileDictationTarget },
  { transcriptSoFar: heard }: { transcriptSoFar: string },
  activeHandle: string | null
) {
  // Memoized: the chat preview is a context value every composer reads.
  const chatDictationPreview = useMemo<MobileNativeChatDictationPreview | null>(
    () =>
      heard && target?.field === 'chat'
        ? { scope: target.scope, anchor: target.anchor, text: heard }
        : null,
    [heard, target]
  )
  const commandDictationPreview = useMemo(
    () => (heard && target?.field === 'command' ? { anchor: target.anchor, text: heard } : null),
    [heard, target]
  )
  return {
    chatDictationPreview,
    commandDictationPreview,
    liveDictationText: target?.field === 'live' && target.handle === activeHandle ? heard : ''
  }
}
