import { HEADER_BYTES } from './browser-extension-native-host-framing'

const MAX_OUTGOING_MESSAGE_BYTES = 64 * 1024 * 1024
const MAX_HOST_WRITE_BYTES = MAX_OUTGOING_MESSAGE_BYTES + HEADER_BYTES
const MAX_PROCESS_WRITE_BYTES = 2 * MAX_HOST_WRITE_BYTES
const MAX_HOST_WRITES = 256
const MAX_PROCESS_WRITES = 1024

let processWriteBytes = 0
let processWrites = 0

export function createNativeHostWriteAdmission(): {
  claim: (bodyBytes: number) => (() => void) | undefined
  close: () => void
} {
  const pending = new Set<() => void>()
  let pendingBytes = 0
  let closed = false

  return {
    claim: (bodyBytes) => {
      const bytes = HEADER_BYTES + bodyBytes
      if (
        closed ||
        bodyBytes > MAX_OUTGOING_MESSAGE_BYTES ||
        pending.size >= MAX_HOST_WRITES ||
        pendingBytes + bytes > MAX_HOST_WRITE_BYTES ||
        processWrites >= MAX_PROCESS_WRITES ||
        processWriteBytes + bytes > MAX_PROCESS_WRITE_BYTES
      ) {
        return undefined
      }
      pendingBytes += bytes
      processWriteBytes += bytes
      processWrites++
      const release = (): void => {
        if (!pending.delete(release)) {
          return
        }
        pendingBytes -= bytes
        processWriteBytes -= bytes
        processWrites--
      }
      pending.add(release)
      return release
    },
    close: () => {
      closed = true
      for (const release of pending) {
        release()
      }
    }
  }
}
