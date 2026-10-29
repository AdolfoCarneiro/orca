import type { PublishedWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-published'
import type { RuntimeMobileSessionSnapshotTab as Row } from '../../../shared/runtime-mobile-session-tab-contracts'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../shared/runtime-types'

/** Rebuilds retain the open intent only for the same ordinary destination resource. */
export function preserveSessionTabOpenPlacement(row: Row, prior: Row | undefined): Row {
  if (row.type === 'agent-session' && prior?.type === 'agent-session') {
    return row.openPlacement || row.id !== prior.id || row.sessionId !== prior.sessionId
      ? row
      : { ...row, ...(prior.openPlacement ? { openPlacement: prior.openPlacement } : {}) }
  }
  if (
    row.type === 'terminal' &&
    prior?.type === 'terminal' &&
    !row.openPlacement &&
    prior.openPlacement &&
    row.id === prior.id &&
    row.parentTabId === prior.parentTabId &&
    row.leafId === prior.leafId &&
    (!prior.ptyId || row.ptyId === prior.ptyId) &&
    (!prior.incarnationId || row.incarnationId === prior.incarnationId)
  ) {
    return { ...row, openPlacement: prior.openPlacement }
  }
  return row
}

export function preserveSessionTabOpenPlacements(
  snapshot: RuntimeMobileSessionTabsSnapshot,
  existing: RuntimeMobileSessionTabsSnapshot | undefined
): RuntimeMobileSessionTabsSnapshot {
  if (
    !existing ||
    (snapshot.worktreeInstanceId &&
      existing.worktreeInstanceId &&
      snapshot.worktreeInstanceId !== existing.worktreeInstanceId)
  ) {
    return snapshot
  }
  const prior = new Map(existing.tabs.map((row) => [row.id, row]))
  return {
    ...snapshot,
    tabs: snapshot.tabs.map((row) => preserveSessionTabOpenPlacement(row, prior.get(row.id)))
  }
}

/** Frames and snapshots carry the same unsaved intent from the ordinary row owner. */
export function withPublishedSessionTabOpenPlacements(
  layout: PublishedWorkspaceLayout,
  snapshot: RuntimeMobileSessionTabsSnapshot | undefined
): PublishedWorkspaceLayout {
  const chats = new Map<string, Extract<Row, { type: 'agent-session' }>>()
  const terminals = new Map<string, Extract<Row, { type: 'terminal' }>[]>()
  for (const row of snapshot?.tabs ?? []) {
    if (row.type === 'agent-session' && row.openPlacement) {
      chats.set(row.sessionId, row)
    } else if (row.type === 'terminal' && row.openPlacement) {
      const siblings = terminals.get(row.parentTabId) ?? []
      siblings.push(row)
      terminals.set(row.parentTabId, siblings)
    }
  }
  if (chats.size === 0 && terminals.size === 0) {
    return layout
  }
  return {
    ...layout,
    tabs: layout.tabs.map((tab) => {
      let openPlacement =
        tab.kind === 'agent-session' ? chats.get(tab.entityId)?.openPlacement : undefined
      if (tab.kind === 'terminal') {
        const panes = new Map(tab.terminal?.panes.map((pane) => [pane.leafId, pane]))
        openPlacement = terminals.get(tab.id)?.find((row) => {
          const pane = panes.get(row.leafId)
          return pane && (!row.ptyId || pane.ptyId === row.ptyId)
        })?.openPlacement
      }
      return openPlacement ? { ...tab, openPlacement } : tab
    })
  }
}
