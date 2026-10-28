import type { PersistedState } from '../../../shared/persisted-state-types'

import type { SessionUnitReader, SessionUnitSelection } from '../../../shared/session-unit-reader'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'

import { normalizeBrowserHistoryEntries } from '../../../shared/workspace-session-browser-history'

import { isWslMoveWorkspaceSessionFrozen } from '../moving-wsl-projects/wsl-move-scope-guard'
import {
  type normalizeSessionPaneUnits,
  remapAcknowledgedAgentPaneKeys,
  remapActivityClearedAtPaneKeys,
  remapManuallyUnreadTurnPaneKeys,
  remapSshRemotePtyLeaseLeafIds
} from '../restoring-sessions/workspace-pane-normalization'

export function normalizeSnapshotHistory(reader: SessionUnitReader): void {
  if (!reader.touches('browserUrlHistory')) {
    return
  }
  const history = reader.field('browserUrlHistory').value
  if (!history) {
    return
  }
  const next = normalizeBrowserHistoryEntries(history)
  if (next.length !== history.length || next.some((value, index) => value !== history[index])) {
    reader.replace('browserUrlHistory', { present: true, value: next })
  }
}

export function keepFrozenSnapshotUnits(
  reader: SessionUnitReader,
  selection: SessionUnitSelection
): void {
  for (const [field, keys] of selection) {
    for (const key of keys) {
      if ([...reader.ids(field, key, 'owner')].some(isWslMoveWorkspaceSessionFrozen)) {
        reader.write(field, key, reader.unit(field, key, 'prior'))
      }
    }
  }
}

export function preparePaneRemapEffects(
  state: PersistedState,
  normalized: ReturnType<typeof normalizeSessionPaneUnits>,
  hostId: ExecutionHostId,
  tabs: ReadonlySet<string>,
  full: boolean
) {
  const ack = remapAcknowledgedAgentPaneKeys(
    state.ui?.acknowledgedAgentsByPaneKey,
    normalized.leafIdByInputLeafIdByTabId
  )
  const activity = remapActivityClearedAtPaneKeys(
    state.ui?.activityClearedAtByPaneKey,
    normalized.leafIdByInputLeafIdByTabId
  )
  const unread = remapManuallyUnreadTurnPaneKeys(
    state.ui?.manuallyUnreadTurnsByPaneKey,
    normalized.leafIdByInputLeafIdByTabId
  )
  const ui =
    ack.changed || activity.changed || unread.changed
      ? {
          ...state.ui,
          ...(ack.changed ? { acknowledgedAgentsByPaneKey: ack.acknowledgements } : {}),
          ...(activity.changed ? { activityClearedAtByPaneKey: activity.cutoffs } : {}),
          ...(unread.changed ? { manuallyUnreadTurnsByPaneKey: unread.turns } : {})
        }
      : undefined
  const leases = remapSshRemotePtyLeaseLeafIds(
    state.sshRemotePtyLeases ?? [],
    new Map([[hostId, normalized]]),
    new Set([
      LOCAL_EXECUTION_HOST_ID,
      ...Object.keys(state.workspaceSessionsByHostId ?? {}).filter(
        (key): key is ExecutionHostId => parseExecutionHostId(key) !== null
      )
    ]),
    full ? undefined : tabs
  )
  return { ui, leases: leases.changed ? leases.leases : undefined }
}
