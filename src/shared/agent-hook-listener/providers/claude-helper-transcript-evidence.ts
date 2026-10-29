import type { ClaudeTranscriptCursor } from './claude-transcript-cursor'
import { isKnownHarnessInjectedUserTurnText } from '../../harness-injected-user-turns'

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
    if (record.type === 'assistant' && Number.isFinite(at)) {
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
    if (record.type !== 'user') {
      continue
    }
    const result = record.toolUseResult
    for (const item of content) {
      if (!isRecord(item) || item.type !== 'tool_result' || typeof item.tool_use_id !== 'string') {
        continue
      }
      const started = evidence.launches.get(item.tool_use_id)
      evidence.launches.delete(item.tool_use_id)
      if (
        started === undefined ||
        item.is_error === true ||
        !isRecord(result) ||
        result.isAsync !== true ||
        typeof result.agentId !== 'string'
      ) {
        continue
      }
      evidence.resumedAt.set(
        result.agentId,
        Math.max(evidence.resumedAt.get(result.agentId) ?? 0, started)
      )
    }
  }
}

export type ClaudeChildTranscript = { cursor: ClaudeTranscriptCursor; promptedAt?: number }

export function readClaudeChildPrompts(
  child: ClaudeChildTranscript,
  records: Record<string, unknown>[]
): void {
  for (const record of records) {
    if (record.type !== 'user' || record.isMeta === true || record.isCompactSummary === true) {
      continue
    }
    const content = messageContent(record)
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content
    if (
      !Array.isArray(blocks) ||
      blocks.some((item) => isRecord(item) && item.type === 'tool_result')
    ) {
      continue
    }
    const text = blocks.some(
      (item) =>
        isRecord(item) &&
        item.type === 'text' &&
        typeof item.text === 'string' &&
        item.text.trim() !== '' &&
        !isKnownHarnessInjectedUserTurnText(item.text)
    )
    const at = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : Number.NaN
    if (text && Number.isFinite(at)) {
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
