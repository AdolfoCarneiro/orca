import type {
  AgentJournalCursor,
  AgentJournalRenderItem
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionTextPatches } from '../../../shared/agent-session-text-patches'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { JournalTextDeltaRow } from '../agent-session-journal/journal-text-rows'
import { AGENT_SESSION_MAX_STREAMS } from './agent-session-delta-coalescer'
import { BOUNDED_FRAME_ROW_BYTES } from './agent-session-bounded-frame-item'

export type TextBaseline = {
  revision: number
  lengths: Map<number, number>
  shortened: boolean
  bodyBytes: number
}

type TextWindow = {
  cursor: AgentJournalCursor
  rows: JournalTextDeltaRow[]
  items: ReadonlyMap<string, AgentJournalRenderItem>
}

/** Larger backlogs, gaps, controls and replacements use the normal whole-item catch-up path. */
export function readAgentSessionTextWindow(
  journal: AgentSessionJournal,
  after: AgentJournalCursor
): TextWindow | null {
  const since = journal.readSince(after, AGENT_SESSION_MAX_STREAMS + 1)
  if (!since.ok || since.rows.length === 0 || since.rows.length > AGENT_SESSION_MAX_STREAMS) {
    return null
  }
  const rows: JournalTextDeltaRow[] = []
  const revisions = new Map<string, number>()
  for (const row of since.rows) {
    if (
      row.kind !== 'text-delta' ||
      row.seq !== after.sequence + rows.length + 1 ||
      journal.canonicalItemId(row.itemId) !== row.itemId
    ) {
      return null
    }
    rows.push(row)
    revisions.set(row.itemId, row.revision)
  }
  if (rows.at(-1)?.seq !== since.cursor.sequence) {
    return null
  }
  const items = new Map(
    journal
      .snapshot()
      .items.filter((item) => revisions.has(item.itemId))
      .map((item) => [item.itemId, item])
  )
  for (const [id, revision] of revisions) {
    if (items.get(id)?.revision !== revision) {
      return null
    }
  }
  return { cursor: since.cursor, rows, items }
}

export function agentSessionTextWindowPatches(
  window: TextWindow,
  after: AgentJournalCursor,
  baselines: ReadonlyMap<string, TextBaseline>,
  budgetBytes: number,
  bounded: boolean
): AgentSessionTextPatches | null {
  const staged = new Map<string, TextBaseline>()
  const patches: AgentSessionTextPatches = { after, items: [] }
  for (const row of window.rows) {
    const baseline = staged.get(row.itemId) ?? baselines.get(row.itemId)
    const current = window.items.get(row.itemId)
    if (
      !current ||
      !baseline ||
      baseline.shortened ||
      baseline.revision !== row.predecessor ||
      baseline.lengths.get(row.field) !== row.baseLength
    ) {
      return null
    }
    const { body: _body, ...metadata } = current
    const item = { ...metadata, revision: row.revision }
    const bodyBytes = baseline.bodyBytes + Buffer.byteLength(JSON.stringify(row.suffix), 'utf8') - 2
    const itemBytes = bodyBytes + Buffer.byteLength(JSON.stringify({ ...item, body: null }), 'utf8')
    if (itemBytes > (bounded ? BOUNDED_FRAME_ROW_BYTES : budgetBytes)) {
      return null
    }
    patches.items.push({
      item,
      field: row.field,
      predecessor: row.predecessor,
      baseLength: row.baseLength,
      suffix: row.suffix
    })
    staged.set(row.itemId, {
      ...baseline,
      revision: row.revision,
      bodyBytes,
      lengths: new Map([...baseline.lengths, [row.field, row.baseLength + row.suffix.length]])
    })
  }
  return Buffer.byteLength(JSON.stringify(patches), 'utf8') <= budgetBytes ? patches : null
}
