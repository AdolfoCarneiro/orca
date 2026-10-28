import { useEffect, type RefObject } from 'react'
import type { TextInput } from 'react-native'
import { isNewerApprovalSubject } from '../../../../../src/shared/agent-session-approval-subject'
import type { AskPrompt } from '../../../../../src/shared/native-chat/input/native-chat-ask-types'
import type { MobileChatPermission } from './mobile-native-chat-permission'

// As on desktop a shown card replaces the composer (kept mounted for its draft), except during dictation or for an
// approval this build cannot draw, which only a new turn can cancel.
export function useMobileNativeChatPromptInputOwner(
  {
    promptShown,
    ask,
    permission,
    micActive
  }: {
    promptShown: boolean
    ask?: AskPrompt | null
    permission?: MobileChatPermission | null
    micActive?: boolean
  },
  composerInputRef: RefObject<TextInput | null> | undefined
): boolean {
  const owns =
    promptShown && !micActive && (ask != null || !isNewerApprovalSubject(permission?.subject))
  useEffect(() => {
    if (owns) {
      composerInputRef?.current?.blur()
    }
  }, [owns, composerInputRef])
  return owns
}
