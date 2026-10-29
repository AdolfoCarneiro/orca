import { createHash } from 'node:crypto'
import type { StructuredAttentionOrigin } from '../../shared/agent-session-attention'
import { resolveEnvironment } from '../../shared/runtime-environment-store'
import { deriveRelayHostId } from '../runtime/mobile-cloud-relay/relay-http-client'

export function structuredPushOccurrence(
  subject: string | undefined,
  origin: StructuredAttentionOrigin | undefined
): string | undefined {
  return subject && origin
    ? createHash('sha256')
        .update(
          JSON.stringify([subject, origin.journalCursor.epoch, origin.journalCursor.sequence])
        )
        .digest('base64url')
    : undefined
}

export function forwardedPushOrigin(
  userDataPath: string,
  environmentId: string
): string | undefined {
  try {
    const environment = resolveEnvironment(userDataPath, environmentId)
    const keys = [...new Set(environment.endpoints.map((endpoint) => endpoint.publicKeyB64))]
    if (keys.length !== 1) {
      return undefined
    }
    const key = Buffer.from(keys[0], 'base64')
    return key.length === 32 ? deriveRelayHostId(key) : undefined
  } catch {
    return undefined
  }
}
