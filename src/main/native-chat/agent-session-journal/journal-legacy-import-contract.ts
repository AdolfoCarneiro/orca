import type { AdoptedTranscriptSource } from './adopted-transcript-source'
import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import type { NativeChatTurnLifecycle } from '../../../shared/native-chat-types'
import type { ResolveSessionFileOptions } from '../session-file-resolver'
import type { JournalReplacementItem } from './journal-epoch-replacement'
import type { JournalPayloadLimits } from './journal-payload-bounds'
export type LegacyImportOptions = ResolveSessionFileOptions & {
  filePath?: string
  source?: AdoptedTranscriptSource
  limits?: JournalPayloadLimits
  decodedMessageIdentities?: true
}

export type LegacyImportResult =
  | {
      ok: true
      epoch: string
      cursor: AgentJournalCursor
      imported: number
      replaced: boolean
    }
  | { ok: false; error: string }

export type PreparedLegacyImport =
  | {
      ok: true
      items: JournalReplacementItem[]
      sourceEmpty: boolean
      latestTurn?: NativeChatTurnLifecycle
    }
  | { ok: false; error: string }
