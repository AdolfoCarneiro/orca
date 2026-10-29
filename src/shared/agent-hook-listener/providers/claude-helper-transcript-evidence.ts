import type { ClaudeTranscriptCursor } from './claude-transcript-cursor'

export type ClaudeHelperTranscriptEvidence = {
  observedAt: number
  killedAt?: number
  resumedAt: Map<string, number>
  launches: Map<string, number>
}

export function readClaudeHelperEvidence(
  evidence: ClaudeHelperTranscriptEvidence,
  records: Record<string, unknown>[]
): void {
  for (const record of records) {
    const at = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : Number.NaN
    if (!Number.isFinite(at)) {
      continue
    }
    if (
      record.type === 'system' &&
      record.subtype === 'agents_killed' &&
      at >= evidence.observedAt
    ) {
      evidence.killedAt = Math.max(evidence.killedAt ?? 0, at)
    }
    const content = messageContent(record)
    if (!Array.isArray(content)) {
      continue
    }
    if (record.type === 'assistant') {
      for (const item of content) {
        if (
          isRecord(item) &&
          item.type === 'tool_use' &&
          (item.name === 'Agent' || item.name === 'Task') &&
          typeof item.id === 'string'
        ) {
          evidence.launches.set(item.id, at)
        }
      }
    }
    const result = record.toolUseResult
    if (
      record.type !== 'user' ||
      !isRecord(result) ||
      result.isAsync !== true ||
      typeof result.agentId !== 'string'
    ) {
      continue
    }
    for (const item of content) {
      if (
        !isRecord(item) ||
        item.type !== 'tool_result' ||
        item.is_error === true ||
        typeof item.tool_use_id !== 'string'
      ) {
        continue
      }
      const started = evidence.launches.get(item.tool_use_id)
      if (started === undefined) {
        continue
      }
      evidence.resumedAt.set(
        result.agentId,
        Math.max(evidence.resumedAt.get(result.agentId) ?? 0, started)
      )
      evidence.launches.delete(item.tool_use_id)
    }
  }
}

export type ClaudeChildTranscript = { cursor: ClaudeTranscriptCursor; promptedAt?: number }

export function readClaudeChildPrompts(
  child: ClaudeChildTranscript,
  records: Record<string, unknown>[]
): void {
  for (const record of records) {
    if (record.type !== 'user') {
      continue
    }
    const content = messageContent(record)
    const text =
      typeof content === 'string' ||
      (Array.isArray(content) && content.some((item) => isRecord(item) && item.type === 'text'))
    const at = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : Number.NaN
    if (
      text &&
      record.isMeta !== true &&
      !(typeof content === 'string' && content.startsWith('[Request interrupted by user')) &&
      Number.isFinite(at)
    ) {
      child.promptedAt = Math.max(child.promptedAt ?? 0, at)
    }
  }
}

function messageContent(record: Record<string, unknown>): unknown {
  return isRecord(record.message) ? record.message.content : undefined
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
