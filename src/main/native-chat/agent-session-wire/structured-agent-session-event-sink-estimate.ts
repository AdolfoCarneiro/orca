import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../../shared/agent-session-journal-types'

export function estimateStructuredAgentSessionItemBytes(
  identity: AgentJournalItemIdentity,
  body: AgentJournalItemBody
): number {
  return Buffer.byteLength(JSON.stringify({ identity, body }), 'utf8') + 512
}

/** Count concatenated text without allocating it, including pairs split across chunks. */
export function jsonTextBytes(chunks: readonly string[]): number {
  let bytes = 2
  let high = false
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++) {
      const code = chunk.charCodeAt(i)
      if (high) {
        high = false
        if (code >= 0xdc00 && code <= 0xdfff) {
          bytes += 4
          continue
        }
        bytes += 6
      }
      if (code >= 0xd800 && code <= 0xdbff) {
        high = true
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        bytes += 6
      } else if (code === 34 || code === 92 || [8, 9, 10, 12, 13].includes(code)) {
        bytes += 2
      } else if (code < 32) {
        bytes += 6
      } else {
        bytes += code < 128 ? 1 : code < 2048 ? 2 : 3
      }
    }
  }
  return bytes + (high ? 6 : 0)
}

/** Plain journal JSON, counted before materializing an expanded item. */
export function jsonValueBytes(value: unknown): number {
  if (typeof value === 'string') {
    return jsonTextBytes([value])
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)?.length ?? 0
  }
  if (Array.isArray(value)) {
    return (
      2 +
      Math.max(0, value.length - 1) +
      value.reduce((n, item) => n + (jsonValueBytes(item) || 4), 0)
    )
  }
  const entries = Object.entries(value).filter(([, item]) => item !== undefined)
  return (
    2 +
    Math.max(0, entries.length - 1) +
    entries.reduce((n, [key, item]) => n + jsonTextBytes([key]) + 1 + jsonValueBytes(item), 0)
  )
}
