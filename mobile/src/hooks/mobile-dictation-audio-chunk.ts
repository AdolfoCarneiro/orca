import {
  MOBILE_DICTATION_CONNECTION_SLOW_ERROR_MESSAGE,
  MOBILE_DICTATION_PCM_SAMPLE_RATE
} from './mobile-dictation-pending-audio-budget'
import { bytesToBase64 } from './mobile-dictation-session-state'
import { dictationAudioChunkSend } from '../dictation/mobile-dictation-operations'
import { MOBILE_DICTATION_RECONNECT_GRACE_MS } from '../../../src/shared/rpc-contract/speech-params'
import { isRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { rpcPayloadMember } from '../transport/rpc-reader-payload'
import { isLogicalClientCutoverError } from '../transport/stable-logical-rpc-client'
import type { DictationCaptureChunk } from '../platform/dictation-capture-contract'
import type { MobileDictationPendingAudioBudget } from './mobile-dictation-pending-audio-budget'
import type { RpcClient } from '../transport/rpc-client'

type MobileDictationAudioChunkQueue = {
  pendingChunks: Set<Promise<void>>
  pendingAudioBudget: MobileDictationPendingAudioBudget
  shouldReleaseBudget: (dictationId: string) => boolean
  failActiveDictation: (dictationId: string, err: unknown) => void
  noteTranscriptSoFar: (dictationId: string, text: string) => void
}

export function enqueueMobileDictationAudioChunk(
  client: RpcClient,
  dictationId: string,
  chunk: DictationCaptureChunk,
  queue: MobileDictationAudioChunkQueue
): void {
  const bytes = chunk.data
  const byteLength = bytes.byteLength
  if (!queue.pendingAudioBudget.tryReserve(byteLength)) {
    queue.failActiveDictation(
      dictationId,
      new Error(MOBILE_DICTATION_CONNECTION_SLOW_ERROR_MESSAGE)
    )
    return
  }
  const params = {
    dictationId,
    audioBase64: bytesToBase64(bytes),
    sampleRate: MOBILE_DICTATION_PCM_SAMPLE_RATE
  }
  // Wait for a reconnect only as long as the host keeps the session; past that, fail and keep the text so far.
  const options = { timeoutMs: MOBILE_DICTATION_RECONNECT_GRACE_MS }
  const sendChunk = dictationAudioChunkSend
    .request(client, params, options)
    .catch((err: unknown) =>
      // A chunk still waiting when the connection moved never reached the host; send it on the new one.
      isLogicalClientCutoverError(err) && !isRpcDeliveryUnknown(err)
        ? dictationAudioChunkSend.request(client, params, options)
        : Promise.reject(err)
    )
    .then((reply) => {
      // Only newer hosts send the text so far; any other result still acknowledges the chunk.
      const result = dictationAudioChunkSend.interpret(reply)
      const text = result == null ? undefined : rpcPayloadMember(result, 'text')
      if (typeof text === 'string') {
        queue.noteTranscriptSoFar(dictationId, text)
      }
    })
    .catch((err) => {
      // The host keeps the session through a reconnect; only audio in flight at the drop is lost.
      if (!isRpcDeliveryUnknown(err)) {
        queue.failActiveDictation(dictationId, err)
      }
    })
    .finally(() => {
      if (queue.shouldReleaseBudget(dictationId)) {
        queue.pendingAudioBudget.release(byteLength)
      }
      queue.pendingChunks.delete(sendChunk)
    })
  queue.pendingChunks.add(sendChunk)
}
