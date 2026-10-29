import { useEffect, useEffectEvent } from 'react'
import type { UseMobileDictationResult } from '../hooks/mobile-dictation-session-state'
import { nativeChatDictationCopy } from './mobile-session-native-chat-dictation-copy'

export const DICTATION_SILENCE_STOP_MS = 60_000

// A forgotten tap-mode mic keeps the screen awake; a finger holding the button is never forgotten.
export function useMobileDictationSilenceStop(
  dictation: Pick<UseMobileDictationResult, 'isRecording' | 'meter'>,
  dictationMode: string | undefined,
  stop: () => void,
  showToast: (message: string) => void
): void {
  const { meter } = dictation
  const watching = dictation.isRecording && dictationMode !== 'hold'
  const stopForSilence = useEffectEvent(() => {
    showToast(nativeChatDictationCopy.stoppedAfterSilence())
    stop()
  })

  useEffect(() => {
    if (!watching) {
      return
    }
    // Wall clock, so a stalled audio stream still counts as silence.
    let lastSpeechAt = Date.now()
    let timer: ReturnType<typeof setTimeout>
    const check = () => {
      if (meter.getSnapshot().isSpeaking) {
        lastSpeechAt = Date.now()
      }
      const remainingMs = lastSpeechAt + DICTATION_SILENCE_STOP_MS - Date.now()
      if (remainingMs > 0) {
        timer = setTimeout(check, remainingMs)
      } else {
        stopForSilence()
      }
    }
    timer = setTimeout(check, DICTATION_SILENCE_STOP_MS)
    const unsubscribe = meter.subscribe(() => {
      if (meter.getSnapshot().isSpeaking) {
        lastSpeechAt = Date.now()
      }
    })
    return () => {
      clearTimeout(timer)
      unsubscribe()
    }
  }, [meter, watching])
}
