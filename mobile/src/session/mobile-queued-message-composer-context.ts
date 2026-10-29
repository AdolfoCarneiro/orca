import type { NativeChatSkillDiscoverySnapshot } from '../../../src/shared/native-chat/input/native-chat-picker-items'
import { createContext } from 'react'
import type { MobileNativeChatStructuredComposer } from './native-chat/composer/MobileNativeChatComposer'
import type { MobileNativeChatDictationPreview } from './native-chat/composer/mobile-native-chat-draft-inputs'

export const MobileQueuedMessageComposerContext = createContext<{
  agent: string | null
  structured: MobileNativeChatStructuredComposer | null
  skillDiscovery?: NativeChatSkillDiscoverySnapshot
  onNeedSkills?: () => void
  filePaths: string[]
  onNeedFiles: ((query: string) => void) | undefined
  onError: (text: string) => void
  onMicPress: (() => void) | undefined
  micActive: boolean
  micStarting: boolean
  micProcessing: boolean
  dictationPreview?: MobileNativeChatDictationPreview | null
  dictationMode: string | undefined
  onMicPressIn: () => void
  onMicPressOut: () => void
} | null>(null)
